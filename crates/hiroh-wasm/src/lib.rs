//! Hiroh's WebAssembly module: device keys, relay settings, messaging between
//! paired devices (chat.rs) and file transfer (files.rs). Built on iroh,
//! iroh-gossip and iroh-blobs.
//!
//! Copyright (c) 2026 DexWorks Pty Ltd. MIT licence, see LICENSE in the
//! repository root.

mod files;
mod relay;

use std::str::FromStr;
use wasm_bindgen::prelude::*;

fn js_err(err: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&err.to_string())
}

/// Relay mode for the app's relay settings (JSON; missing means defaults).
fn relay_mode_from(json: Option<String>) -> Result<iroh::endpoint::RelayMode, JsValue> {
    let settings = relay::parse(json.as_deref()).map_err(js_err)?;
    relay::relay_mode(&settings).map_err(js_err)
}

// ---------------------------------------------------------------------------
// Messaging between paired browsers (iroh-gossip). See chat.rs.
// ---------------------------------------------------------------------------

mod chat;

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

struct ChatChannel {
    sender: chat::ChatSender,
    _reader: n0_future::task::AbortOnDropHandle<()>,
}

struct ChatState {
    node: chat::ChatNode,
    callback: js_sys::Function,
    channels: RefCell<HashMap<chat::TopicId, ChatChannel>>,
}

thread_local! {
    static CHAT: RefCell<Option<Rc<ChatState>>> = const { RefCell::new(None) };
}

fn chat_state() -> Result<Rc<ChatState>, JsValue> {
    CHAT.with(|slot| slot.borrow().clone())
        .ok_or_else(|| JsValue::from_str("messaging is not started"))
}

fn parse_topic(topic: &str) -> Result<chat::TopicId, JsValue> {
    chat::TopicId::from_str(topic).map_err(js_err)
}

/// Public device key (endpoint id) for a hex-encoded secret key, without
/// starting anything. Used to register a device before it connects.
#[wasm_bindgen]
pub fn endpoint_id_of(secret_hex: &str) -> Result<String, JsValue> {
    let key = iroh::SecretKey::from_str(secret_hex).map_err(js_err)?;
    Ok(key.public().to_string())
}

/// New random messaging identity, hex-encoded. Kept apart from the file
/// transfer key so the two endpoints never share an id on the relay.
#[wasm_bindgen]
pub fn chat_generate_secret() -> String {
    iroh::SecretKey::generate()
        .to_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Start (or restart) the messaging endpoint. `callback(topicId, eventJson)`
/// receives every channel event. Returns this device's endpoint id.
#[wasm_bindgen]
pub async fn chat_start(
    secret_hex: String,
    relay_json: Option<String>,
    callback: js_sys::Function,
) -> Result<String, JsValue> {
    chat_stop().await;
    let key = iroh::SecretKey::from_str(&secret_hex).map_err(js_err)?;
    // No reachability probe and no fallback here: the endpoint starts on the
    // chosen relay at once, and chat_relay_status reports how that link is
    // doing (including a refused token) from iroh's own status.
    let relay_mode = relay_mode_from(relay_json)?;
    let node = chat::ChatNode::spawn(key, relay_mode)
        .await
        .map_err(js_err)?;
    let id = node.endpoint_id().to_string();
    let state = Rc::new(ChatState {
        node,
        callback,
        channels: RefCell::new(HashMap::new()),
    });
    CHAT.with(|slot| *slot.borrow_mut() = Some(state));
    Ok(id)
}

/// The messaging endpoint's link to its relay, as JSON (see `RelayReport`).
#[wasm_bindgen]
pub fn chat_relay_status() -> Result<String, JsValue> {
    let state = chat_state()?;
    serde_json::to_string(&state.node.relay_report()).map_err(js_err)
}

/// The public relays this build of iroh uses by default, as a JSON list of URLs.
/// They come from iroh itself, so the list follows iroh updates.
#[wasm_bindgen]
pub fn public_relays() -> String {
    let urls: Vec<String> = relay::public_relay_urls()
        .into_iter()
        .map(|u| u.to_string())
        .collect();
    serde_json::to_string(&urls).unwrap_or_else(|_| "[]".to_string())
}

/// Try relay settings without saving them: connects a throwaway endpoint and
/// returns a `RelayReport` as JSON. Waits at most `wait_ms`.
#[wasm_bindgen]
pub async fn relay_test(relay_json: Option<String>, wait_ms: u32) -> Result<String, JsValue> {
    let mode = relay_mode_from(relay_json)?;
    let report = chat::test_relay(mode, n0_future::time::Duration::from_millis(wait_ms.into()))
        .await
        .map_err(js_err)?;
    serde_json::to_string(&report).map_err(js_err)
}

/// Shut the messaging endpoint down.
#[wasm_bindgen]
pub async fn chat_stop() {
    let state = CHAT.with(|slot| slot.borrow_mut().take());
    if let Some(state) = state {
        state.channels.borrow_mut().clear();
        state.node.shutdown().await;
    }
}

async fn chat_join_inner(
    state: Rc<ChatState>,
    ticket: chat::ChatTicket,
    nickname: String,
) -> Result<chat::TopicId, JsValue> {
    let topic = ticket.topic_id;
    if state.channels.borrow().contains_key(&topic) {
        return Ok(topic);
    }
    let (sender, mut receiver) = state.node.join(&ticket, nickname).await.map_err(js_err)?;
    let callback = state.callback.clone();
    let topic_str = JsValue::from_str(&topic.to_string());
    let reader = n0_future::task::spawn(async move {
        use n0_future::StreamExt;
        while let Some(event) = receiver.next().await {
            let json = match event {
                Ok(event) => serde_json::to_string(&event).unwrap_or_default(),
                Err(err) => serde_json::json!({ "type": "error", "message": err.to_string() })
                    .to_string(),
            };
            let _ = callback.call2(&JsValue::NULL, &topic_str, &JsValue::from_str(&json));
        }
    });
    state.channels.borrow_mut().insert(
        topic,
        ChatChannel {
            sender,
            _reader: n0_future::task::AbortOnDropHandle::new(reader),
        },
    );
    Ok(topic)
}

/// Open a new pairing channel. Returns a ticket (topic + this device) for
/// the other device to join.
#[wasm_bindgen]
pub async fn chat_create(nickname: String) -> Result<String, JsValue> {
    let state = chat_state()?;
    let mut ticket = chat::ChatTicket::new_random().map_err(js_err)?;
    chat_join_inner(state.clone(), ticket.clone(), nickname).await?;
    ticket.bootstrap.insert(state.node.addr().await);
    Ok(iroh_tickets::Ticket::encode_string(&ticket))
}

/// Join a channel from a ticket, plus any known peer endpoint ids.
/// Returns the topic id (hex).
#[wasm_bindgen]
pub async fn chat_join(
    ticket: String,
    peers: Vec<String>,
    nickname: String,
) -> Result<String, JsValue> {
    let state = chat_state()?;
    let mut ticket = chat::ChatTicket::deserialize(&ticket).map_err(js_err)?;
    for peer in peers {
        let id = chat::EndpointId::from_str(&peer).map_err(js_err)?;
        if !ticket.bootstrap.iter().any(|addr| addr.id == id) {
            ticket.bootstrap.insert(iroh::EndpointAddr::new(id));
        }
    }
    let topic = chat_join_inner(state, ticket, nickname).await?;
    Ok(topic.to_string())
}

/// Decode a ticket without joining. Returns JSON `{ topic, peers, relays }`,
/// where `relays` are the relay URLs the inviting device was reachable on.
#[wasm_bindgen]
pub fn chat_ticket_info(ticket: String) -> Result<String, JsValue> {
    let ticket = chat::ChatTicket::deserialize(&ticket).map_err(js_err)?;
    let peers: Vec<String> = ticket.bootstrap.iter().map(|p| p.id.to_string()).collect();
    let relays: Vec<String> = ticket
        .bootstrap
        .iter()
        .flat_map(|p| p.relay_urls().map(|u| u.to_string()))
        .collect();
    Ok(serde_json::json!({
        "topic": ticket.topic_id.to_string(),
        "peers": peers,
        "relays": relays,
    })
    .to_string())
}

/// Ticket for an open channel that names this device as the bootstrap peer.
#[wasm_bindgen]
pub async fn chat_ticket(topic: String) -> Result<String, JsValue> {
    let state = chat_state()?;
    let mut ticket = chat::ChatTicket::new(parse_topic(&topic)?);
    ticket.bootstrap.insert(state.node.addr().await);
    Ok(iroh_tickets::Ticket::encode_string(&ticket))
}

/// Send a signed text message on a channel.
#[wasm_bindgen]
pub async fn chat_send(topic: String, text: String) -> Result<(), JsValue> {
    let state = chat_state()?;
    let sender = state
        .channels
        .borrow()
        .get(&parse_topic(&topic)?)
        .map(|c| c.sender.clone())
        .ok_or_else(|| JsValue::from_str("channel is not open"))?;
    sender.send(text).await.map_err(js_err)
}

/// Change the name this device announces on every channel.
#[wasm_bindgen]
pub fn chat_set_nickname(nickname: String) -> Result<(), JsValue> {
    let state = chat_state()?;
    for channel in state.channels.borrow().values() {
        channel.sender.set_nickname(nickname.clone());
    }
    Ok(())
}

/// Set which endpoint ids may connect (the paired devices).
#[wasm_bindgen]
pub fn chat_set_allowed(peers: Vec<String>) -> Result<(), JsValue> {
    let state = chat_state()?;
    let mut allowed = std::collections::HashSet::new();
    for peer in peers {
        allowed.insert(chat::EndpointId::from_str(&peer).map_err(js_err)?);
    }
    state.node.admission.lock().expect("poisoned").allowed = allowed;
    Ok(())
}

/// Accept connections from unknown devices while a pairing code is shown.
#[wasm_bindgen]
pub fn chat_set_pairing_open(open: bool) -> Result<(), JsValue> {
    let state = chat_state()?;
    state.node.admission.lock().expect("poisoned").pairing_open = open;
    Ok(())
}

/// Leave a channel.
#[wasm_bindgen]
pub fn chat_leave(topic: String) -> Result<(), JsValue> {
    let state = chat_state()?;
    state.channels.borrow_mut().remove(&parse_topic(&topic)?);
    Ok(())
}

// ---------------------------------------------------------------------------
// File transfer (iroh-blobs). See files.rs.
// ---------------------------------------------------------------------------

struct FilesState {
    node: Rc<files::FilesNode>,
    /// The key and relay settings the node was started with.
    config: (String, String),
}

thread_local! {
    static FILES: RefCell<Option<FilesState>> = const { RefCell::new(None) };
    static FILES_KEY: RefCell<Option<String>> = const { RefCell::new(None) };
    static FILES_CALLBACK: RefCell<Option<js_sys::Function>> = const { RefCell::new(None) };
}

fn report_files_event(event: files::FilesEvent) {
    use files::FilesEvent::*;
    let (name, payload) = match event {
        SendStarted => ("send-started", None),
        SendProgress { done, total } => ("send-progress", Some(format!("{done}:{total}"))),
        SendDone => ("send-done", None),
        ReceiveProgress { done, total } => ("receive-progress", Some(format!("{done}:{total}"))),
    };
    FILES_CALLBACK.with(|slot| {
        if let Some(callback) = slot.borrow().as_ref() {
            let payload = payload.map(JsValue::from).unwrap_or(JsValue::NULL);
            let _ = callback.call2(&JsValue::NULL, &JsValue::from_str(name), &payload);
        }
    });
}

/// `callback(eventName, payload)` receives transfer events: "send-started",
/// "send-progress" ("done:total" in bytes), "send-done", "receive-progress".
#[wasm_bindgen]
pub fn files_on_event(callback: js_sys::Function) {
    FILES_CALLBACK.with(|slot| *slot.borrow_mut() = Some(callback));
}

/// The device key for file transfer, hex-encoded. Kept across page loads so
/// the relay recognises the device.
#[wasm_bindgen]
pub fn files_set_key(secret_hex: &str) -> Result<(), JsValue> {
    iroh::SecretKey::from_str(secret_hex).map_err(js_err)?;
    FILES_KEY.with(|slot| *slot.borrow_mut() = Some(secret_hex.to_string()));
    Ok(())
}

/// The transfer node for these relay settings, started or restarted as needed.
async fn files_node(relay_json: Option<String>) -> Result<Rc<files::FilesNode>, JsValue> {
    let key_hex = FILES_KEY
        .with(|slot| slot.borrow().clone())
        .ok_or_else(|| JsValue::from_str("no device key set for file transfer"))?;
    let config = (key_hex.clone(), relay_json.clone().unwrap_or_default());
    let existing = FILES.with(|slot| {
        slot.borrow()
            .as_ref()
            .filter(|s| s.config == config)
            .map(|s| s.node.clone())
    });
    if let Some(node) = existing {
        return Ok(node);
    }
    let old = FILES.with(|slot| slot.borrow_mut().take());
    if let Some(old) = old {
        old.node.shutdown().await;
    }
    let key = iroh::SecretKey::from_str(&key_hex).map_err(js_err)?;
    let mode = relay_mode_from(relay_json)?;
    let node = Rc::new(
        files::FilesNode::spawn(key, mode, report_files_event)
            .await
            .map_err(js_err)?,
    );
    FILES.with(|slot| {
        *slot.borrow_mut() = Some(FilesState {
            node: node.clone(),
            config,
        })
    });
    Ok(node)
}

/// Serve files to whoever has the returned ticket. Replaces anything served before.
#[wasm_bindgen]
pub async fn files_share(
    names: Vec<String>,
    contents: js_sys::Array,
    relay_json: Option<String>,
) -> Result<String, JsValue> {
    if names.len() as u32 != contents.length() {
        return Err(JsValue::from_str("each file needs a name"));
    }
    let files = names
        .into_iter()
        .zip(contents.iter())
        .map(|(name, data)| (name, js_sys::Uint8Array::new(&data).to_vec()))
        .collect();
    let node = files_node(relay_json).await?;
    let ticket = node.share(files).await.map_err(js_err)?;
    Ok(iroh_tickets::Ticket::encode_string(&ticket))
}

/// Stop serving files. Tickets handed out earlier stop working.
#[wasm_bindgen]
pub fn files_stop() {
    FILES.with(|slot| {
        if let Some(state) = slot.borrow().as_ref() {
            state.node.stop();
        }
    });
}

/// The files a ticket offers, as JSON `[{"name", "size"}]`. No network needed.
#[wasm_bindgen]
pub fn files_list(ticket: &str) -> Result<String, JsValue> {
    use iroh_tickets::Ticket;
    let ticket = files::FilesTicket::decode_string(ticket.trim()).map_err(js_err)?;
    serde_json::to_string(&ticket.files).map_err(js_err)
}

/// Fetch everything a ticket offers. Returns `{ names: string[], data: Uint8Array[] }`.
#[wasm_bindgen]
pub async fn files_receive(ticket: String, relay_json: Option<String>) -> Result<JsValue, JsValue> {
    use iroh_tickets::Ticket;
    let ticket = files::FilesTicket::decode_string(ticket.trim()).map_err(js_err)?;
    let node = files_node(relay_json).await?;
    let names = js_sys::Array::new();
    let data = js_sys::Array::new();
    node.receive(&ticket, |name, bytes| {
        names.push(&JsValue::from_str(name));
        data.push(&js_sys::Uint8Array::from(bytes));
    })
    .await
    .map_err(js_err)?;
    let result = js_sys::Object::new();
    js_sys::Reflect::set(&result, &"names".into(), &names)?;
    js_sys::Reflect::set(&result, &"data".into(), &data)?;
    Ok(result.into())
}
