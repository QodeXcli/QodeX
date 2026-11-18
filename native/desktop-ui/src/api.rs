//! Loopback client for the desktop shell. A public host is refused here,
//! before any socket is opened.

use serde::Deserialize;

#[derive(Clone, Debug)]
pub struct ShellUrl {
    pub origin: String,
    pub token: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Wait {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub prompt: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Goal {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub status: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Desk {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub runnable: bool,
    #[serde(default)]
    pub goals: Vec<Goal>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Audit {
    #[serde(default)]
    pub ts: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub detail: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Control {
    #[serde(default)]
    pub app: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub value: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Live {
    #[serde(default)]
    pub resident: String,
    #[serde(default)]
    pub pending: u32,
    #[serde(default)]
    pub result: String,
    #[serde(default)]
    pub shot: bool,
    #[serde(default)]
    pub waits: Vec<Wait>,
    #[serde(default)]
    pub desks: Vec<Desk>,
    #[serde(default)]
    pub audit: Vec<Audit>,
    #[serde(default)]
    pub controls: Vec<Control>,
}

/// `http://127.0.0.1:<port>/?k=<token>` only. No userinfo, no other host.
pub fn parse_shell_url(raw: &str) -> Result<ShellUrl, String> {
    let url = raw.trim();
    if url.contains('@') || url.contains('\\') || url.contains('#') {
        return Err("refused: the native window only opens a loopback shell url".into());
    }
    let rest = url
        .strip_prefix("http://127.0.0.1:")
        .ok_or_else(|| "refused: host must be 127.0.0.1".to_string())?;
    let (port, tail) = rest.split_once('/').ok_or_else(|| "refused: missing path".to_string())?;
    if !port.chars().all(|c| c.is_ascii_digit()) || port.parse::<u16>().ok().filter(|p| *p > 0).is_none() {
        return Err("refused: bad port".into());
    }
    let query = tail.trim_start_matches('?');
    let token = query
        .split('&')
        .find_map(|pair| pair.strip_prefix("k="))
        .unwrap_or("");
    if token.len() < 8 || token.len() > 64 || !token.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("refused: missing shell token".into());
    }
    Ok(ShellUrl { origin: format!("http://127.0.0.1:{port}"), token: token.to_string() })
}

pub fn enc(raw: &str) -> String {
    let mut out = String::new();
    for b in raw.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

pub fn act_body(fields: &[(&str, &str)]) -> String {
    fields.iter().map(|(k, v)| format!("{}={}", enc(k), enc(v))).collect::<Vec<_>>().join("&")
}

pub fn parse_live(body: &str) -> Result<Live, String> {
    serde_json::from_str(body).map_err(|err| format!("live json: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_loopback_with_a_token() {
        let ok = parse_shell_url("http://127.0.0.1:4311/?k=abcdef12").unwrap();
        assert_eq!(ok.origin, "http://127.0.0.1:4311");
        assert_eq!(ok.token, "abcdef12");
        assert!(parse_shell_url("https://example.com/?k=abcdef12").is_err());
        assert!(parse_shell_url("http://127.0.0.1:9/?k=short").is_err());
        assert!(parse_shell_url("http://user:pw@127.0.0.1:9/?k=abcdef12").is_err());
    }

    #[test]
    fn form_and_live_round_trip() {
        let body = act_body(&[("action", "type"), ("name", "A & B"), ("text", "café")]);
        assert!(body.contains("name=A+%26+B"));
        assert!(body.contains("text=caf%C3%A9"));
        let live = parse_live(r#"{"resident":"off","shot":true,"desks":[{"id":"research","name":"research","runnable":true,"goals":[{"id":"abcd1234","text":"hi","status":"queued"}]}],"controls":[{"name":"Allow","role":"button","app":"Notes","enabled":true,"value":""}]}"#).unwrap();
        assert!(live.shot);
        assert_eq!(live.desks[0].id, "research");
        assert_eq!(live.controls[0].name, "Allow");
    }
}
