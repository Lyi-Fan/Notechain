fn main() {
    // Cargo links the complete CRT statically. Tauri's optional hybrid CRT mode
    // would exclude libucrt and contradict cargo-xwin's static-link flags.
    if std::env::var("CARGO_CFG_TARGET_FEATURE").unwrap_or_default().split(',').any(|feature| feature == "crt-static") {
        std::env::remove_var("STATIC_VCRUNTIME");
    }
    tauri_build::build()
}
