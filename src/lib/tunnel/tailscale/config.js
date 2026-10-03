// Tailscale Funnel: cert provisioning + *.ts.net DNS propagation slower → longer timeouts
export const HEALTH_CHECK = {
  enableTimeoutMs: 20000, // Enable flow waits short; watchdog re-verifies afterwards
  intervalMs: 2000,
  timeoutMs: 180000,
  fetchTimeoutMs: 8000,
  dnsTimeoutMs: 3000,
};
