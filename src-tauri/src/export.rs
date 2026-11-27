//! Output of a finished (annotated) image: clipboard and PNG files.
//!
//! The editor renders the final PNG and sends it as raw IPC body, which
//! avoids JSON-encoding megabytes of image data.

use std::{
    borrow::Cow,
    path::{Path, PathBuf},
};

use tauri::{
    AppHandle, Manager,
    ipc::{InvokeBody, Request},
};

const SAVE_DIR_NAME: &str = "Pasta";
/// Header carrying a percent-encoded target path or file name.
const PATH_HEADER: &str = "x-pasta-path";

#[tauri::command]
pub async fn copy_png(request: Request<'_>) -> Result<(), String> {
    let image = image::load_from_memory_with_format(raw_body(&request)?, image::ImageFormat::Png)
        .map_err(err)?
        .to_rgba8();

    let mut clipboard = arboard::Clipboard::new().map_err(err)?;
    clipboard
        .set_image(arboard::ImageData {
            width: image.width() as usize,
            height: image.height() as usize,
            bytes: Cow::Owned(image.into_raw()),
        })
        .map_err(err)
}

/// Saves the PNG and returns the path written.
///
/// The path header holds either an absolute path ("save as") or just a file
/// name, which is placed in `Pictures/Pasta` without overwriting anything.
#[tauri::command]
pub async fn save_png(app: AppHandle, request: Request<'_>) -> Result<String, String> {
    let requested = PathBuf::from(path_header(&request)?);
    let target = if requested.is_absolute() {
        requested
    } else {
        let file_name = requested.file_name().ok_or("missing file name")?;
        let dir = app.path().picture_dir().map_err(err)?.join(SAVE_DIR_NAME);
        std::fs::create_dir_all(&dir).map_err(err)?;
        unique_path(&dir.join(file_name))
    };

    std::fs::write(&target, raw_body(&request)?).map_err(err)?;
    Ok(target.to_string_lossy().into_owned())
}

fn raw_body<'a>(request: &'a Request<'_>) -> Result<&'a [u8], String> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes),
        InvokeBody::Json(_) => Err("expected raw PNG body".into()),
    }
}

fn path_header(request: &Request<'_>) -> Result<String, String> {
    let value = request
        .headers()
        .get(PATH_HEADER)
        .ok_or("missing path header")?
        .to_str()
        .map_err(err)?;
    percent_decode(value)
}

/// Appends " (2)", " (3)", … to the file stem until the path is free.
fn unique_path(path: &Path) -> PathBuf {
    if !path.exists() {
        return path.to_owned();
    }
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let ext = path.extension().map(|e| e.to_string_lossy());
    (2..)
        .map(|n| {
            let name = match &ext {
                Some(ext) => format!("{stem} ({n}).{ext}"),
                None => format!("{stem} ({n})"),
            };
            path.with_file_name(name)
        })
        .find(|candidate| !candidate.exists())
        .expect("unbounded range")
}

/// Decodes `encodeURIComponent` output.
fn percent_decode(input: &str) -> Result<String, String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = input.get(i + 1..i + 3).ok_or("truncated escape")?;
            out.push(u8::from_str_radix(hex, 16).map_err(err)?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(err)
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_decode_handles_umlauts_and_spaces() {
        assert_eq!(
            percent_decode("Bilder%2FPasta%20%C3%BCbung.png").unwrap(),
            "Bilder/Pasta übung.png"
        );
        assert!(percent_decode("%4").is_err());
    }

    #[test]
    fn unique_path_appends_counter() {
        let dir = std::env::temp_dir().join(format!("pasta-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let first = dir.join("shot.png");
        assert_eq!(unique_path(&first), first);

        std::fs::write(&first, b"x").unwrap();
        assert_eq!(unique_path(&first), dir.join("shot (2).png"));

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
