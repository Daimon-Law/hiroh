//! Copyright (c) 2026 DexWorks Pty Ltd. MIT licence. Based on n0's browser-chat
//! example (MIT OR Apache-2.0); see the notice below.
//!
//! Text messaging between paired browsers over iroh-gossip.
//!
//! Ported from n0's official browser-chat example
//! (https://github.com/n0-computer/iroh-examples/tree/main/browser-chat,
//! `shared/src/lib.rs`, MIT OR Apache-2.0). Changes from the example:
//! the endpoint takes the Hiroh site's relay settings and a persisted secret
//! key, the topic id comes from `getrandom` instead of `rand`, and tickets
//! carry full `EndpointAddr`s (id + relay URL) that are fed to iroh's
//! `MemoryLookup`, so pairing does not depend on the n0 DNS lookup alone.
//!
//! No custom cryptography: links are iroh QUIC (TLS 1.3, rustls + ring) and
//! each message is signed with the sender's iroh Ed25519 key, exactly as in
//! the example.

use std::{
    collections::{BTreeSet, HashSet},
    sync::{Arc, Mutex},
};

use anyhow::{Context, Result};
pub use iroh::EndpointId;
use iroh::{address_lookup::memory::MemoryLookup, endpoint::Connection, protocol::{AcceptError, ProtocolHandler, Router}, EndpointAddr, PublicKey, SecretKey, Signature};
pub use iroh_gossip::proto::TopicId;
use iroh_gossip::{
    api::{Event as GossipEvent, GossipSender},
    net::{Gossip, GOSSIP_ALPN},
};
use iroh_tickets::Ticket;
use n0_future::{
    boxed::BoxStream,
    task::{self, AbortOnDropHandle},
    time::{Duration, SystemTime},
    StreamExt,
};
use iroh::endpoint::RelayMode;
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex as TokioMutex, Notify};

pub const PRESENCE_INTERVAL: Duration = Duration::from_secs(5);
pub const MAX_MESSAGE_SIZE: usize = 64 * 1024;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ChatTicket {
    pub topic_id: TopicId,
    pub bootstrap: BTreeSet<EndpointAddr>,
}

impl ChatTicket {
    pub fn new_random() -> Result<Self> {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(|e| anyhow::anyhow!("getrandom: {e}"))?;
        Ok(Self::new(TopicId::from_bytes(bytes)))
    }

    pub fn new(topic_id: TopicId) -> Self {
        Self {
            topic_id,
            bootstrap: Default::default(),
        }
    }
    pub fn deserialize(input: &str) -> Result<Self> {
        <Self as Ticket>::decode_string(input).map_err(Into::into)
    }
}

impl Ticket for ChatTicket {
    const KIND: &'static str = "hirohchat";

    fn encode_bytes(&self) -> Vec<u8> {
        postcard::to_stdvec(&self).unwrap()
    }

    fn decode_bytes(bytes: &[u8]) -> Result<Self, iroh_tickets::ParseError> {
        let ticket = postcard::from_bytes(bytes)?;
        Ok(ticket)
    }
}

/// Who may open a gossip connection to this device: the paired devices, plus
/// anyone while a pairing QR code is on screen. Everyone else is refused
/// before gossip sees the connection, so a leaked pairing link cannot be
/// used later to join a channel and read messages.
#[derive(Debug, Default)]
pub struct Admission {
    pub allowed: HashSet<EndpointId>,
    pub pairing_open: bool,
}

#[derive(Debug, Clone)]
struct PairedOnly {
    gossip: Gossip,
    admission: Arc<Mutex<Admission>>,
}

impl ProtocolHandler for PairedOnly {
    async fn accept(&self, connection: Connection) -> Result<(), AcceptError> {
        let remote = connection.remote_id();
        let admitted = {
            let admission = self.admission.lock().expect("poisoned");
            admission.pairing_open || admission.allowed.contains(&remote)
        };
        if !admitted {
            tracing::info!("refused gossip connection from unpaired {}", remote.fmt_short());
            connection.close(1u32.into(), b"not paired");
            return Ok(());
        }
        self.gossip
            .handle_connection(connection)
            .await
            .map_err(AcceptError::from_err)
    }

    async fn shutdown(&self) {
        self.gossip.shutdown().await.ok();
    }
}

pub struct ChatNode {
    secret_key: SecretKey,
    router: Router,
    gossip: Gossip,
    memory: MemoryLookup,
    pub admission: Arc<Mutex<Admission>>,
}

impl ChatNode {
    /// Spawns a gossip node on the given relay settings.
    pub async fn spawn(secret_key: SecretKey, relay_mode: RelayMode) -> Result<Self> {
        let memory = MemoryLookup::new();
        let endpoint = iroh::Endpoint::builder(iroh::endpoint::presets::N0)
        .secret_key(secret_key.clone())
        .relay_mode(relay_mode)
        .address_lookup(memory.clone())
        .alpns(vec![GOSSIP_ALPN.to_vec()])
        .bind()
        .await?;

        // Default is 4 KiB; raised so a pasted key file or config block fits.
        // Every browser on a Hiroh site runs this same build, so both ends agree.
        let gossip = Gossip::builder()
            .max_message_size(MAX_MESSAGE_SIZE)
            .spawn(endpoint.clone());
        let admission = Arc::new(Mutex::new(Admission::default()));
        let router = Router::builder(endpoint)
            .accept(
                GOSSIP_ALPN,
                PairedOnly {
                    gossip: gossip.clone(),
                    admission: admission.clone(),
                },
            )
            .spawn();
        Ok(Self {
            gossip,
            router,
            secret_key,
            memory,
            admission,
        })
    }

    pub fn endpoint_id(&self) -> EndpointId {
        self.router.endpoint().id()
    }

    /// This endpoint's address, once it has a home relay (waits up to 15 s).
    pub async fn addr(&self) -> EndpointAddr {
        let endpoint = self.router.endpoint();
        for _ in 0..60 {
            let addr = endpoint.addr();
            if addr.relay_urls().next().is_some() {
                return addr;
            }
            n0_future::time::sleep(Duration::from_millis(250)).await;
        }
        endpoint.addr()
    }

    /// Joins a channel from a ticket.
    pub async fn join(
        &self,
        ticket: &ChatTicket,
        nickname: String,
    ) -> Result<(ChatSender, BoxStream<Result<Event>>)> {
        let topic_id = ticket.topic_id;
        let me = self.endpoint_id();
        for addr in &ticket.bootstrap {
            if addr.id != me && addr.relay_urls().next().is_some() {
                self.memory.add_endpoint_info(addr.clone());
            }
        }
        let bootstrap = ticket
            .bootstrap
            .iter()
            .map(|addr| addr.id)
            .filter(|id| *id != me)
            .collect();
        let gossip_topic = self.gossip.subscribe(topic_id, bootstrap).await?;
        let (sender, receiver) = gossip_topic.split();

        let nickname = Arc::new(Mutex::new(nickname));
        let trigger_presence = Arc::new(Notify::new());

        // Periodic presence lets each side see which peers are online.
        let sender = Arc::new(TokioMutex::new(sender));
        let presence_task = AbortOnDropHandle::new(task::spawn({
            let secret_key = self.secret_key.clone();
            let sender = sender.clone();
            let trigger_presence = trigger_presence.clone();
            let nickname = nickname.clone();

            async move {
                loop {
                    let nickname = nickname.lock().expect("poisoned").clone();
                    let message = Message::Presence { nickname };
                    let signed_message = SignedMessage::sign_and_encode(&secret_key, message)
                        .expect("failed to encode message");
                    if let Err(err) = sender.lock().await.broadcast(signed_message.into()).await {
                        tracing::warn!("presence task failed to broadcast: {err}");
                        break;
                    }
                    n0_future::future::race(
                        n0_future::time::sleep(PRESENCE_INTERVAL),
                        trigger_presence.notified(),
                    )
                    .await;
                }
            }
        }));

        let receiver = n0_future::stream::try_unfold(receiver, {
            let trigger_presence = trigger_presence.clone();
            move |mut receiver| {
                let trigger_presence = trigger_presence.clone();
                async move {
                    loop {
                        let was_joined = receiver.is_joined();
                        let Some(event) = receiver.try_next().await? else {
                            return Ok(None);
                        };
                        let event: Event = match event.try_into() {
                            Ok(event) => event,
                            Err(err) => {
                                tracing::warn!("received invalid message: {err}");
                                continue;
                            }
                        };
                        if !was_joined && receiver.is_joined() {
                            trigger_presence.notify_waiters()
                        };
                        break Ok(Some((event, receiver)));
                    }
                }
            }
        });

        let sender = ChatSender {
            secret_key: self.secret_key.clone(),
            nickname,
            sender,
            trigger_presence,
            _presence_task: Arc::new(presence_task),
        };
        Ok((sender, Box::pin(receiver)))
    }

    pub async fn shutdown(&self) {
        if let Err(err) = self.router.shutdown().await {
            tracing::warn!("failed to shutdown router cleanly: {err}");
        }
        self.router.endpoint().close().await;
    }
}

#[derive(Debug, Clone)]
pub struct ChatSender {
    nickname: Arc<Mutex<String>>,
    secret_key: SecretKey,
    sender: Arc<TokioMutex<GossipSender>>,
    trigger_presence: Arc<Notify>,
    _presence_task: Arc<AbortOnDropHandle<()>>,
}

impl ChatSender {
    pub async fn send(&self, text: String) -> Result<()> {
        let nickname = self.nickname.lock().expect("poisoned").clone();
        let message = Message::Message { text, nickname };
        let signed_message = SignedMessage::sign_and_encode(&self.secret_key, message)?;
        self.sender
            .lock()
            .await
            .broadcast(signed_message.into())
            .await?;
        Ok(())
    }

    pub fn set_nickname(&self, name: String) {
        *self.nickname.lock().expect("poisoned") = name;
        self.trigger_presence.notify_waiters();
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Event {
    #[serde(rename_all = "camelCase")]
    Joined { neighbors: Vec<EndpointId> },
    #[serde(rename_all = "camelCase")]
    MessageReceived {
        from: EndpointId,
        text: String,
        nickname: String,
        sent_timestamp: u64,
    },
    #[serde(rename_all = "camelCase")]
    Presence {
        from: EndpointId,
        nickname: String,
        sent_timestamp: u64,
    },
    #[serde(rename_all = "camelCase")]
    NeighborUp { endpoint_id: EndpointId },
    #[serde(rename_all = "camelCase")]
    NeighborDown { endpoint_id: EndpointId },
    Lagged,
}

impl TryFrom<GossipEvent> for Event {
    type Error = anyhow::Error;
    fn try_from(event: GossipEvent) -> Result<Self, Self::Error> {
        let converted = match event {
            GossipEvent::NeighborUp(endpoint_id) => Self::NeighborUp { endpoint_id },
            GossipEvent::NeighborDown(endpoint_id) => Self::NeighborDown { endpoint_id },
            GossipEvent::Received(message) => {
                let message = SignedMessage::verify_and_decode(&message.content)
                    .context("failed to parse and verify signed message")?;
                match message.message {
                    Message::Presence { nickname } => Self::Presence {
                        from: message.from,
                        nickname,
                        sent_timestamp: message.timestamp,
                    },
                    Message::Message { text, nickname } => Self::MessageReceived {
                        from: message.from,
                        text,
                        nickname,
                        sent_timestamp: message.timestamp,
                    },
                }
            }
            GossipEvent::Lagged => Self::Lagged,
        };
        Ok(converted)
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct SignedMessage {
    from: PublicKey,
    data: Vec<u8>,
    signature: Signature,
}

impl SignedMessage {
    pub fn verify_and_decode(bytes: &[u8]) -> Result<ReceivedMessage> {
        let signed_message: Self = postcard::from_bytes(bytes)?;
        let key: PublicKey = signed_message.from;
        key.verify(&signed_message.data, &signed_message.signature)?;
        let message: WireMessage = postcard::from_bytes(&signed_message.data)?;
        let WireMessage::VO { timestamp, message } = message;
        Ok(ReceivedMessage {
            from: signed_message.from,
            timestamp,
            message,
        })
    }

    pub fn sign_and_encode(secret_key: &SecretKey, message: Message) -> Result<Vec<u8>> {
        let timestamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_micros() as u64;
        let wire_message = WireMessage::VO { timestamp, message };
        let data = postcard::to_stdvec(&wire_message)?;
        let signature = secret_key.sign(&data);
        let from: PublicKey = secret_key.public();
        let signed_message = Self {
            from,
            data,
            signature,
        };
        let encoded = postcard::to_stdvec(&signed_message)?;
        Ok(encoded)
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub enum WireMessage {
    VO { timestamp: u64, message: Message },
}

#[derive(Debug, Serialize, Deserialize)]
pub enum Message {
    Presence { nickname: String },
    Message { text: String, nickname: String },
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ReceivedMessage {
    timestamp: u64,
    from: EndpointId,
    message: Message,
}

// ---------------------------------------------------------------- relay status

/// What the page shows about the relay link. Built from iroh's documented
/// `Endpoint::home_relay_status()`, which reports the connection state, the
/// last error and whether the relay refused our access token.
#[derive(Debug, Clone, Serialize)]
pub struct RelayReport {
    /// Home relay URL, once the endpoint has picked one.
    pub url: Option<String>,
    pub connected: bool,
    /// Set when the relay refused our credentials (wrong or missing token).
    pub denied: Option<String>,
    /// The last connection error, for display only.
    pub error: Option<String>,
    /// Time to connect, for a test.
    pub ms: Option<u64>,
}

fn report_from(statuses: &[iroh::endpoint::RelayStatus]) -> RelayReport {
    let pick = statuses
        .iter()
        .find(|s| s.is_connected())
        .or_else(|| statuses.first());
    match pick {
        None => RelayReport {
            url: None,
            connected: false,
            denied: None,
            error: None,
            ms: None,
        },
        Some(s) => RelayReport {
            url: Some(s.url().to_string()),
            connected: s.is_connected(),
            denied: s.auth_denied_reason().map(str::to_string),
            error: if s.is_connected() {
                None
            } else {
                s.last_error().map(|e| e.to_string())
            },
            ms: None,
        },
    }
}

impl ChatNode {
    /// Current state of this endpoint's link to its home relay.
    pub fn relay_report(&self) -> RelayReport {
        use iroh::Watcher;
        report_from(&self.router.endpoint().home_relay_status().get())
    }
}

/// Connects a throwaway endpoint (fresh random key) with the given relay
/// settings and reports whether it came online, how long it took, or why not.
/// Never falls back to other relays.
pub async fn test_relay(relay_mode: RelayMode, wait: Duration) -> Result<RelayReport> {
    use iroh::Watcher;
    let endpoint = iroh::Endpoint::builder(iroh::endpoint::presets::Minimal)
    .secret_key(SecretKey::generate())
    .relay_mode(relay_mode)
    .bind()
    .await?;
    let start = n0_future::time::Instant::now();
    let mut watcher = endpoint.home_relay_status();
    let outcome = n0_future::time::timeout(wait, async {
        loop {
            let report = report_from(&watcher.get());
            if report.connected || report.denied.is_some() {
                return report;
            }
            if watcher.updated().await.is_err() {
                return report;
            }
        }
    })
    .await;
    let mut report = match outcome {
        Ok(report) => report,
        Err(_) => {
            let mut report = report_from(&watcher.get());
            if report.error.is_none() {
                report.error = Some("No answer from the relay in time".to_string());
            }
            report
        }
    };
    if report.connected {
        report.ms = Some(start.elapsed().as_millis() as u64);
    }
    endpoint.close().await;
    Ok(report)
}

