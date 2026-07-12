// WebKit-only AirPlay API (Safari on macOS/iOS/iPadOS). These members are not in
// the standard DOM lib, so we augment them here to avoid `any` casts in player.ts.
// Everywhere else (Chrome/Firefox) the methods/props are simply absent, which the
// runtime feature-detection in getAudio() handles.

// The availability event carries a string flag: "available" | "not-available".
interface WebKitPlaybackTargetAvailabilityEvent extends Event {
  readonly availability: "available" | "not-available";
}

interface HTMLMediaElement {
  webkitShowPlaybackTargetPicker?: () => void;
  readonly webkitCurrentPlaybackTargetIsWireless?: boolean;
}

interface HTMLMediaElementEventMap {
  webkitplaybacktargetavailabilitychanged: WebKitPlaybackTargetAvailabilityEvent;
  webkitcurrentplaybacktargetiswirelesschanged: Event;
}
