//! Relay settings: which iroh relays a browser endpoint uses.
//!
//! Copyright (c) 2026 DexWorks Pty Ltd. MIT licence.

use anyhow::{bail, Context, Result};
use iroh::{endpoint::RelayMode, RelayMap, RelayUrl};
use serde::Deserialize;

/// Relay settings as the web app sends them (JSON).
#[derive(Debug, Default, Deserialize)]
pub struct RelaySettings {
    /// "default" (iroh's public relays), "custom", or "disabled". A browser
    /// cannot connect without a relay, so "disabled" means the public relays.
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub urls: Vec<String>,
    #[serde(default)]
    pub auth_token: Option<String>,
}

/// Reads relay settings from JSON. Missing or blank means the defaults.
pub fn parse(json: Option<&str>) -> Result<RelaySettings> {
    match json.map(str::trim) {
        None | Some("") => Ok(RelaySettings::default()),
        Some(raw) => serde_json::from_str(raw).context("unreadable relay settings"),
    }
}

/// The iroh relay mode for these settings.
pub fn relay_mode(settings: &RelaySettings) -> Result<RelayMode> {
    if settings.mode != "custom" {
        return Ok(RelayMode::Custom(public_relays()));
    }
    let token = settings
        .auth_token
        .as_deref()
        .filter(|t| !t.is_empty());
    let mut urls = Vec::new();
    for raw in settings.urls.iter().map(|u| u.trim()).filter(|u| !u.is_empty()) {
        let url: RelayUrl = raw.parse().with_context(|| format!("invalid relay URL: {raw}"))?;
        // A token sent over plain HTTP could be read on the way.
        if token.is_some() && url.scheme() != "https" {
            bail!("Relay URLs must use https when an auth token is configured");
        }
        urls.push(url);
    }
    if urls.is_empty() {
        bail!("no relay URL is set");
    }
    let map = RelayMap::from_iter(urls);
    Ok(RelayMode::Custom(match token {
        Some(token) => {
            if token.trim() != token {
                bail!("the relay token has spaces at the start or end");
            }
            map.with_auth_token(token)
        }
        None => map,
    }))
}

/// iroh's public relays, in a form browsers accept.
///
/// iroh lists them as fully qualified names ending in a root dot
/// ("use1-1.relay.n0.iroh.link."). Browsers refuse such hosts for fetch and
/// WebSocket, so the dot is removed. The list itself comes from iroh.
pub fn public_relays() -> RelayMap {
    RelayMap::from_iter(public_relay_urls())
}

/// The URLs of iroh's public relays, without the trailing root dot.
pub fn public_relay_urls() -> Vec<RelayUrl> {
    iroh::defaults::prod::default_relay_map()
        .urls::<Vec<_>>()
        .into_iter()
        .filter_map(|url| {
            let mut url = (*url).clone();
            if let Some(host) = url.host_str().and_then(|h| h.strip_suffix('.')) {
                let host = host.to_string();
                url.set_host(Some(&host)).ok()?;
            }
            Some(RelayUrl::from(url))
        })
        .collect()
}
