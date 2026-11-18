fn main() {
    napi_build::setup();

    // Link the EndpointSecurity system library on macOS.
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rustc-link-lib=dylib=EndpointSecurity");
        println!("cargo:rustc-link-lib=framework=Security");
        println!("cargo:rustc-link-lib=framework=Foundation");
    }
}
