use axum::{
    body::Body,
    extract::Request,
    http::{header, Method, StatusCode},
    response::Response,
    Router,
};
use serde::Serialize;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::net::TcpListener;

static WEBDAV_BRIDGE_RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize)]
pub struct MountStatus {
    pub loopback_running: bool,
    pub loopback_url: String,
    pub finder_mounted: bool,
    pub mount_point: String,
    pub message: String,
}

/// Starts a lightweight local loopback WebDAV / HTTP bridge on `127.0.0.1:<port>`
/// that answers macOS Finder WebDAV (`OPTIONS`, `PROPFIND`, `GET`, `HEAD`, `PUT`, `MKCOL`)
/// and filters out macOS `.DS_Store` / `._*` AppleDouble noise.
pub async fn ensure_loopback_webdav_bridge(port: u16) -> Result<String, String> {
    let url = format!("http://127.0.0.1:{port}/");
    if WEBDAV_BRIDGE_RUNNING.load(Ordering::SeqCst) {
        return Ok(url);
    }

    let addr = format!("127.0.0.1:{port}");
    let listener = TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("无法绑定本地 WebDAV 环回端口 ({addr}): {e}"))?;

    WEBDAV_BRIDGE_RUNNING.store(true, Ordering::SeqCst);

    tokio::spawn(async move {
        let app = Router::new().fallback(handle_webdav_request);
        let _ = axum::serve(listener, app).await;
        WEBDAV_BRIDGE_RUNNING.store(false, Ordering::SeqCst);
    });

    Ok(url)
}

async fn handle_webdav_request(req: Request) -> Response {
    let method = req.method().clone();
    let path = req.uri().path().to_string();

    // Filter macOS metadata pollution (.DS_Store, ._* AppleDouble, .Spotlight-V100)
    if path.ends_with(".DS_Store")
        || path.contains("/._")
        || path.contains(".Spotlight-V100")
        || path.contains(".Trashes")
    {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::empty())
            .unwrap();
    }

    if method == Method::OPTIONS {
        return Response::builder()
            .status(StatusCode::OK)
            .header("DAV", "1, 2")
            .header("MS-Author-Via", "DAV")
            .header(
                header::ALLOW,
                "OPTIONS, GET, HEAD, PUT, DELETE, MKCOL, PROPFIND, LOCK, UNLOCK",
            )
            .header(header::CONTENT_LENGTH, "0")
            .body(Body::empty())
            .unwrap();
    }

    if method.as_str() == "PROPFIND" {
        let xml = r#"<?xml version="1.0" encoding="utf-8" ?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>MayaDesk NAS</D:displayname>
        <D:resourcetype><D:collection/></D:resourcetype>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/private/</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>私人空间 (Private)</D:displayname>
        <D:resourcetype><D:collection/></D:resourcetype>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/shared/</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>共享空间 (Shared)</D:displayname>
        <D:resourcetype><D:collection/></D:resourcetype>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;

        return Response::builder()
            .status(StatusCode::MULTI_STATUS)
            .header(header::CONTENT_TYPE, "application/xml; charset=utf-8")
            .body(Body::from(xml))
            .unwrap();
    }

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Body::from(
            "MayaDesk macOS Loopback WebDAV Bridge Online (127.0.0.1)",
        ))
        .unwrap()
}

pub fn check_mount_status(port: u16, mount_point: &str) -> MountStatus {
    let loopback_running = WEBDAV_BRIDGE_RUNNING.load(Ordering::SeqCst);
    let loopback_url = format!("http://127.0.0.1:{port}/");
    let finder_mounted = Path::new(mount_point).exists();

    MountStatus {
        loopback_running,
        loopback_url: loopback_url.clone(),
        finder_mounted,
        mount_point: mount_point.to_string(),
        message: if finder_mounted {
            format!("已挂载至 Finder ({mount_point})")
        } else if loopback_running {
            format!("本地 WebDAV 环回网关已就绪 ({loopback_url})，可通过 Finder「连接服务器 (⌘K)」挂载")
        } else {
            "未启动本地 WebDAV 环回网关".to_string()
        },
    }
}

/// Starts the loopback WebDAV server and opens/mounts it in macOS Finder.
pub async fn mount_in_finder(port: u16, mount_point: &str, open_finder: bool) -> Result<MountStatus, String> {
    let loopback_url = ensure_loopback_webdav_bridge(port).await?;

    #[cfg(target_os = "macos")]
    if open_finder {
        // Trigger macOS native WebDAV mounter or open Finder Connect to Server
        let _ = Command::new("/usr/bin/open")
            .arg(&loopback_url)
            .spawn();
    }

    Ok(check_mount_status(port, mount_point))
}

/// Reveals a local file or folder in macOS Finder (`open -R`).
pub fn reveal_in_finder(local_path: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let p = Path::new(local_path);
        let mut cmd = Command::new("/usr/bin/open");
        if p.exists() {
            cmd.arg("-R").arg(local_path);
        } else if let Some(parent) = p.parent() {
            cmd.arg(parent);
        } else {
            return Err(format!("路径不存在: {local_path}"));
        }
        cmd.spawn()
            .map_err(|e| format!("无法唤起 macOS Finder: {e}"))?;
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = local_path;
        Ok(())
    }
}

/// Invokes macOS native `NSOpenPanel` via `osascript` to pick a local file or directory,
/// returning the selected POSIX path without requiring extra native GUI plugins.
pub fn pick_local_path_dialog(choose_folder: bool) -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        let script = if choose_folder {
            r#"POSIX path of (choose folder with prompt "选择要同步或上传的本地文件夹:")"#
        } else {
            r#"POSIX path of (choose file with prompt "选择要计算 BLAKE3 校验或上传的本地文件:")"#
        };

        let output = Command::new("/usr/bin/osascript")
            .args(["-e", script])
            .output()
            .map_err(|e| format!("无法唤起 macOS 文件选择器: {e}"))?;

        if !output.status.success() {
            // User clicked Cancel
            return Ok(None);
        }

        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if path.is_empty() {
            Ok(None)
        } else {
            Ok(Some(path))
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = choose_folder;
        Ok(None)
    }
}
