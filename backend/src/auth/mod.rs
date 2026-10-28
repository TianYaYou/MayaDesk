use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use chrono::Utc;
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UserClaims {
    pub sub: String,
    pub email: String,
    pub display_name: String,
    pub role: String,
    pub exp: usize,
}

#[derive(Debug, Deserialize)]
pub struct EmailLoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    pub email: String,
    pub password: String,
    pub display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct GoogleCallbackQuery {
    pub code: String,
    pub state: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AuthTokenResponse {
    pub access_token: String,
    pub token_type: String,
    pub expires_in: usize,
    pub auth_provider: String, // "email" | "google"
    pub user: UserProfileDto,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UserProfileDto {
    pub id: String,
    pub email: String,
    pub display_name: String,
    pub role: String,
}

pub fn hash_password(raw: &str) -> anyhow::Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();
    let hash = argon2
        .hash_password(raw.as_bytes(), &salt)
        .map_err(|e| anyhow::anyhow!("Argon2 hash failed: {}", e))?
        .to_string();
    Ok(hash)
}

pub fn verify_password(raw: &str, hashed: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(hashed) else {
        return false;
    };
    Argon2::default()
        .verify_password(raw.as_bytes(), &parsed)
        .is_ok()
}

pub fn sign_jwt(
    user: &UserProfileDto,
    secret: &str,
    ttl_secs: usize,
) -> anyhow::Result<String> {
    let exp = (Utc::now().timestamp() as usize) + ttl_secs;
    let claims = UserClaims {
        sub: user.id.clone(),
        email: user.email.clone(),
        display_name: user.display_name.clone(),
        role: user.role.clone(),
        exp,
    };
    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )?;
    Ok(token)
}

pub fn verify_jwt(token: &str, secret: &str) -> anyhow::Result<UserClaims> {
    let data = decode::<UserClaims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    )?;
    Ok(data.claims)
}
