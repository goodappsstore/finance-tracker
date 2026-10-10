fn main() {
    // Native icons are embedded at compile time, including the macOS dev app icon.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
