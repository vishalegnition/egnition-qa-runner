/**
 * Parse CAPSOLVER_PROXY for Playwright and CapSolver API.
 * Formats: host:port:user:pass | host:port | http://user:pass@host:port
 */
export function parseCapsolverProxy(raw) {
  const s = raw?.trim();
  if (!s) return null;

  const urlForm = s.match(/^https?:\/\/(?:([^:]+):([^@]+)@)?([^:/]+):(\d+)\/?$/i);
  if (urlForm) {
    const [, user, pass, host, port] = urlForm;
    const capsolver = user ? `${host}:${port}:${user}:${pass}` : `${host}:${port}`;
    const playwright = {
      server: `http://${host}:${port}`,
      ...(user ? { username: user, password: pass } : {}),
    };
    return { capsolver, playwright };
  }

  const parts = s.split(':');
  if (parts.length >= 4) {
    const host = parts[0];
    const port = parts[1];
    const user = parts[2];
    const pass = parts.slice(3).join(':');
    return {
      capsolver: `${host}:${port}:${user}:${pass}`,
      playwright: {
        server: `http://${host}:${port}`,
        username: user,
        password: pass,
      },
    };
  }

  if (parts.length === 2) {
    const [host, port] = parts;
    return {
      capsolver: `${host}:${port}`,
      playwright: { server: `http://${host}:${port}` },
    };
  }

  throw new Error(
    'Invalid CAPSOLVER_PROXY format. Use host:port:user:pass or http://user:pass@host:port'
  );
}

export function getProxyConfig() {
  try {
    return parseCapsolverProxy(process.env.CAPSOLVER_PROXY);
  } catch (err) {
    console.warn(err.message);
    return null;
  }
}

