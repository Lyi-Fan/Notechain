use objc2::MainThreadMarker;
use objc2_app_kit::{NSView, NSViewFrameDidChangeNotification, NSWindow, NSWindowButton, NSWindowStyleMask};
use objc2_foundation::{NSNotification, NSNotificationCenter};
use block2::RcBlock;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

const TOOLBAR_HEIGHT: f64 = 48.0;
static LAYOUT_GENERATION: AtomicU64 = AtomicU64::new(0);

pub fn install(window: &tauri::WebviewWindow) -> Result<(), String> {
    let _main = MainThreadMarker::new().ok_or("Window chrome requires the main thread")?;
    let pointer = window.ns_window().map_err(|error| error.to_string())?;
    let native = unsafe { &*pointer.cast::<NSWindow>() };
    let center = NSNotificationCenter::defaultCenter();
    let mut observed = Vec::new();
    for kind in [NSWindowButton::CloseButton, NSWindowButton::MiniaturizeButton, NSWindowButton::ZoomButton] {
        let button = native.standardWindowButton(kind).ok_or("Native window button unavailable")?;
        let mut view = Some(unsafe { objc2::rc::Retained::retain((&*button as &NSView) as *const NSView as *mut NSView) }
            .ok_or("Native button view unavailable")?);
        // AppKit can move the titlebar independently of NSWindow resize events.
        for _ in 0..3 {
            let Some(current_view) = view else { break };
            let key = &*current_view as *const NSView as usize;
            if !observed.contains(&key) {
                observed.push(key);
                current_view.setPostsFrameChangedNotifications(true);
                let current = window.clone();
                let block = RcBlock::new(move |_: std::ptr::NonNull<NSNotification>| schedule(&current));
                // This application's main window lives until process exit, as do these observers.
                unsafe { center.addObserverForName_object_queue_usingBlock(
                    Some(NSViewFrameDidChangeNotification), Some(&current_view), None, &block); }
            }
            view = unsafe { current_view.superview() };
        }
    }
    schedule(window);
    Ok(())
}

// AppKit owns these buttons. Position their actual centers in window coordinates;
// the titlebar inset is not the distance from the top edge to a button.
pub fn align(window: &tauri::WebviewWindow) -> Result<Value, String> {
    let _main = MainThreadMarker::new().ok_or("Window chrome requires the main thread")?;
    let pointer = window.ns_window().map_err(|error| error.to_string())?;
    let native = unsafe { &*pointer.cast::<NSWindow>() };
    if native.styleMask().contains(NSWindowStyleMask::FullScreen) {
        return Ok(json!({"fullscreen": true}));
    }
    let height = native.frame().size.height;
    let mut buttons = Vec::new();
    for (name, kind) in [
        ("close", NSWindowButton::CloseButton),
        ("minimize", NSWindowButton::MiniaturizeButton),
        ("zoom", NSWindowButton::ZoomButton),
    ] {
        let button = native.standardWindowButton(kind).ok_or("Native window button unavailable")?;
        let parent = unsafe { button.superview() }.ok_or("Native titlebar unavailable")?;
        let rect = button.convertRect_toView(button.bounds(), None);
        let before = height - rect.origin.y - rect.size.height / 2.0;
        let correction = before - TOOLBAR_HEIGHT / 2.0;
        if correction.abs() > 0.01 {
            // Keep AppKit's button-local frames and hover tracking rectangles together.
            // Give the native titlebar room, then move its whole button group.
            let container = unsafe { parent.superview() }.ok_or("Native titlebar container unavailable")?;
            let mut frame = container.frame();
            let growth = TOOLBAR_HEIGHT.max(parent.frame().size.height) - frame.size.height;
            if growth > 0.01 {
                frame.origin.y -= growth;
                frame.size.height += growth;
                container.setFrame(frame);
            }
            let rect = button.convertRect_toView(button.bounds(), None);
            let correction = height - rect.origin.y - rect.size.height / 2.0 - TOOLBAR_HEIGHT / 2.0;
            let mut origin = parent.frame().origin;
            origin.y += if container.isFlipped() { -correction } else { correction };
            parent.setFrameOrigin(origin);
        }
        button.updateTrackingAreas();
        parent.updateTrackingAreas();
        if let Some(container) = unsafe { parent.superview() } { container.updateTrackingAreas(); }
        let rect = button.convertRect_toView(button.bounds(), None);
        let parent_rect = parent.convertRect_toView(parent.bounds(), None);
        buttons.push(json!({"name": name, "before": before,
            "centerY": height - rect.origin.y - rect.size.height / 2.0,
            "parentTop": height - parent_rect.origin.y - parent_rect.size.height,
            "parentHeight": parent_rect.size.height,
            "localY": button.frame().origin.y,
            "width": rect.size.width, "height": rect.size.height}));
    }
    Ok(json!({"toolbarHeight": TOOLBAR_HEIGHT, "buttons": buttons, "layoutGeneration": LAYOUT_GENERATION.load(Ordering::Relaxed)}))
}

pub fn schedule(window: &tauri::WebviewWindow) {
    let current = window.clone();
    let generation = LAYOUT_GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    tauri::async_runtime::spawn(async move {
        // AppKit lays out the titlebar after the resize/focus callback returns.
        // Coalesce live-resize notifications and adjust after that native layout.
        tokio::time::sleep(Duration::from_millis(40)).await;
        if LAYOUT_GENERATION.load(Ordering::Relaxed) != generation { return; }
        let target = current.clone();
        let _ = current.run_on_main_thread(move || {
            if let Err(error) = align(&target) { eprintln!("Window chrome: {error}"); }
        });
    });
}
