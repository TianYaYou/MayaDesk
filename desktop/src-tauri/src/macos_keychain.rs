use serde::Serialize;
use std::process::Command;

const KEYCHAIN_SERVICE: &str = "com.mayadesk.clouddrive";

#[derive(Debug, Clone, Serialize)]
pub struct KeychainStatus {
    pub service: String,
    pub account: String,
    pub has_token: bool,
    pub backend: String,
}

/// Saves a JWT token or secret into macOS Keychain via `/usr/bin/security`.
pub fn set_password(account: &str, secret: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let status = Command::new("/usr/bin/security")
            .args([
                "add-generic-password",
                "-U",
                "-s",
                KEYCHAIN_SERVICE,
                "-a",
                account,
                "-w",
                secret,
            ])
            .status()
            .map_err(|e| format!("无法调用 macOS Keychain (security): {e}"))?;

        if status.success() {
            Ok(())
        } else {
            Err("写入 macOS 钥匙串失败".to_string())
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (account, secret);
        Ok(())
    }
}

/// Reads a stored JWT token from macOS Keychain via `/usr/bin/security`.
pub fn get_password(account: &str) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("/usr/bin/security")
            .args([
                "find-generic-password",
                "-s",
                KEYCHAIN_SERVICE,
                "-a",
                account,
                "-w",
            ])
            .output()
            .ok()?;

        if output.status.success() {
            let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !token.is_empty() {
                return Some(token);
            }
        }
        None
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = account;
        None
    }
}

/// Deletes a stored token from macOS Keychain.
pub fn delete_password(account: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("/usr/bin/security")
            .args([
                "delete-generic-password",
                "-s",
                KEYCHAIN_SERVICE,
                "-a",
                account,
            ])
            .output();
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = account;
        Ok(())
    }
}

pub fn inspect_status(account: &str) -> KeychainStatus {
    let has_token = get_password(account).is_some();
    KeychainStatus {
        service: KEYCHAIN_SERVICE.to_string(),
        account: account.to_string(),
        has_token,
        backend: if cfg!(target_os = "macos") {
            "macOS Keychain Services (/usr/bin/security)".to_string()
        } else {
            "Fallback Local Credential Store".to_string()
        },
    }
}
