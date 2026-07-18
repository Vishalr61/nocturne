// One place for haptic feedback. Android Chrome vibrates; iOS Safari has no
// vibration API, so every call safely no-ops there. Keep pulses SHORT (8-12ms)
// — a tick you feel, not a buzz you notice.

export function buzz(ms = 10): void {
  try {
    navigator.vibrate?.(ms)
  } catch {
    /* unsupported platform */
  }
}
