//! File transfer between browsers over iroh-blobs.
//!
//! Copyright (c) 2026 DexWorks Pty Ltd. MIT licence.
//!
//! The sender keeps the files in memory and serves them as one iroh-blobs
//! collection. The ticket names the sender's endpoint, the collection hash and
//! the file list. The receiver fetches the collection from the sender; iroh-blobs
//! checks every byte against the BLAKE3 hash in the ticket, and iroh carries the
//! transfer over QUIC with TLS 1.3. Hiroh adds no cryptography of its own.
//!
//! One set of files is served at a time. Serving new files, or stopping,
//! drops the previous set, so its ticket stops working.

use std::sync::{Arc, Mutex};

use anyhow::{anyhow, bail, Context, Result};
use iroh::{
    address_lookup::memory::MemoryLookup,
    endpoint::{Connection, RelayMode},
    protocol::{AcceptError, ProtocolHandler, Router},
    EndpointAddr, SecretKey,
};
use iroh_blobs::{
    api::downloader::{DownloadProgressItem, Downloader, Shuffled},
    format::collection::Collection,
    provider::events::{EventMask, EventSender, ProviderMessage, RequestMode, RequestUpdate},
    store::mem::MemStore,
    BlobsProtocol, Hash, HashAndFormat,
};
use iroh_tickets::Ticket;
use n0_future::StreamExt;
use serde::{Deserialize, Serialize};

/// Everything a receiver needs: who serves the files, what to fetch, and the
/// names and sizes to show before fetching.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilesTicket {
    pub provider: EndpointAddr,
    pub collection: Hash,
    pub files: Vec<FileEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub size: u64,
}

impl Ticket for FilesTicket {
    const KIND: &'static str = "hirohfiles";

    fn encode_bytes(&self) -> Vec<u8> {
        postcard::to_stdvec(self).expect("a ticket always serialises")
    }

    fn decode_bytes(bytes: &[u8]) -> Result<Self, iroh_tickets::ParseError> {
        Ok(postcard::from_bytes(bytes)?)
    }
}

impl FilesTicket {
    pub fn total(&self) -> u64 {
        self.files.iter().map(|f| f.size).sum()
    }
}

/// Progress and state changes reported to the web app.
pub enum FilesEvent {
    /// A receiver started fetching what this device serves.
    SendStarted,
    /// Bytes sent so far, out of the total being served.
    SendProgress { done: u64, total: u64 },
    /// A receiver fetched everything.
    SendDone,
    /// Bytes received so far, out of the ticket's total.
    ReceiveProgress { done: u64, total: u64 },
}

pub type Report = fn(FilesEvent);

/// What this device currently serves. `None` refuses every request.
#[derive(Clone, Default)]
struct Serving(Arc<Mutex<Option<BlobsProtocol>>>);

impl std::fmt::Debug for Serving {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Serving")
    }
}

impl ProtocolHandler for Serving {
    async fn accept(&self, connection: Connection) -> Result<(), AcceptError> {
        let current = self.0.lock().expect("poisoned").clone();
        match current {
            Some(blobs) => blobs.accept(connection).await,
            None => {
                connection.close(1u32.into(), b"nothing shared");
                Ok(())
            }
        }
    }
}

/// The set of files being served, kept alive while it is shared.
struct Shared {
    _store: MemStore,
    _root: iroh_blobs::api::TempTag,
}

/// The transfer endpoint of this browser.
pub struct FilesNode {
    router: Router,
    lookup: MemoryLookup,
    serving: Serving,
    shared: Mutex<Option<Shared>>,
    report: Report,
}

impl FilesNode {
    pub async fn spawn(secret_key: SecretKey, relay_mode: RelayMode, report: Report) -> Result<Self> {
        let lookup = MemoryLookup::new();
        let endpoint = iroh::Endpoint::builder(iroh::endpoint::presets::N0)
            .secret_key(secret_key)
            .relay_mode(relay_mode)
            .address_lookup(lookup.clone())
            .bind()
            .await?;
        let serving = Serving::default();
        let router = Router::builder(endpoint)
            .accept(iroh_blobs::ALPN, serving.clone())
            .spawn();
        Ok(Self {
            router,
            lookup,
            serving,
            shared: Mutex::new(None),
            report,
        })
    }

    /// Serves these files, replacing anything served before. Returns the ticket.
    pub async fn share(&self, files: Vec<(String, Vec<u8>)>) -> Result<FilesTicket> {
        if files.is_empty() {
            bail!("no files to send");
        }
        self.stop();
        let store = MemStore::new();
        let mut collection = Collection::default();
        let mut entries = Vec::with_capacity(files.len());
        for (name, data) in files {
            let size = data.len() as u64;
            let tag = store.add_bytes(data).await?;
            collection.push(name.clone(), tag.hash);
            entries.push(FileEntry { name, size });
        }
        let root = collection.store(&store).await?;
        let total = entries.iter().map(|f| f.size).sum();

        let (events, rx) = EventSender::channel(
            32,
            EventMask {
                get: RequestMode::NotifyLog,
                ..EventMask::DEFAULT
            },
        );
        n0_future::task::spawn(watch_requests(rx, total, self.report));
        *self.serving.0.lock().expect("poisoned") = Some(BlobsProtocol::new(&store, Some(events)));

        let endpoint = self.router.endpoint();
        endpoint.online().await;
        let ticket = FilesTicket {
            provider: endpoint.addr(),
            collection: root.hash(),
            files: entries,
        };
        *self.shared.lock().expect("poisoned") = Some(Shared {
            _store: store,
            _root: root,
        });
        Ok(ticket)
    }

    /// Stops serving. Earlier tickets stop working.
    pub fn stop(&self) {
        *self.serving.0.lock().expect("poisoned") = None;
        *self.shared.lock().expect("poisoned") = None;
    }

    /// Fetches everything a ticket offers and hands each file, in ticket
    /// order, to `on_file` without copying it.
    pub async fn receive(
        &self,
        ticket: &FilesTicket,
        mut on_file: impl FnMut(&str, &[u8]),
    ) -> Result<()> {
        self.lookup.add_endpoint_info(ticket.provider.clone());
        // A separate store per download, freed when the download is handed over.
        let store = MemStore::new();
        let downloader = Downloader::new(&store, self.router.endpoint());
        let request = HashAndFormat::hash_seq(ticket.collection);
        let mut progress = downloader
            .download(request, Shuffled::new(vec![ticket.provider.id]))
            .stream()
            .await?;
        let total = ticket.total();
        while let Some(item) = progress.next().await {
            match item {
                DownloadProgressItem::Progress(done) => {
                    (self.report)(FilesEvent::ReceiveProgress {
                        done: done.min(total),
                        total,
                    });
                }
                DownloadProgressItem::Error(cause) => return Err(anyhow!("{cause}")),
                DownloadProgressItem::DownloadError => {
                    bail!("the sender is not reachable or stopped sharing")
                }
                _ => {}
            }
        }
        let collection = Collection::load(ticket.collection, store.as_ref())
            .await
            .context("the files did not arrive")?;
        for (name, hash) in collection.iter() {
            let bytes = store.blobs().get_bytes(*hash).await?;
            on_file(name, &bytes);
        }
        Ok(())
    }

    pub async fn shutdown(&self) {
        self.stop();
        self.router.shutdown().await.ok();
    }
}

/// Turns iroh-blobs provider events into send progress for the web app.
async fn watch_requests(
    mut rx: tokio::sync::mpsc::Receiver<ProviderMessage>,
    total: u64,
    report: Report,
) {
    while let Some(message) = rx.recv().await {
        let ProviderMessage::GetRequestReceivedNotify(request) = message else {
            continue;
        };
        report(FilesEvent::SendStarted);
        let mut updates = request.rx;
        let report = report.clone();
        n0_future::task::spawn(async move {
            // Bytes of the blobs already finished in this request, and the
            // size of the one in progress.
            let mut finished = 0u64;
            let mut current = 0u64;
            while let Ok(Some(update)) = updates.recv().await {
                match update {
                    RequestUpdate::Started(start) => {
                        finished += current;
                        current = start.size;
                    }
                    RequestUpdate::Progress(p) => {
                        let done = (finished + p.end_offset).min(total);
                        report(FilesEvent::SendProgress { done, total });
                    }
                    RequestUpdate::Completed(_) => {
                        report(FilesEvent::SendProgress { done: total, total });
                        report(FilesEvent::SendDone);
                        break;
                    }
                    RequestUpdate::Aborted(_) => break,
                }
            }
        });
    }
}
