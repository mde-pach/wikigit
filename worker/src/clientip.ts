// The Engine reads the visitor's IP from CF-Connecting-IP, which only Cloudflare
// sets. On the Bun server that header is absent (every visitor would hash to one
// shared `anon-…`) and client-controlled (anyone could pick their identity, dodging
// bans and rate limits). So the Bun entry rewrites it: the nearest proxy's entry in
// X-Forwarded-For (the rightmost — the only hop we can trust), else the socket peer.
export function withClientIp(request: Request, peer: string | undefined): Request {
  const forwarded = request.headers.get("x-forwarded-for");
  const nearest = forwarded?.split(",").at(-1)?.trim();
  const ip = nearest || peer;
  const headers = new Headers(request.headers);
  headers.delete("cf-connecting-ip");
  if (ip) headers.set("cf-connecting-ip", ip);
  return new Request(request, { headers });
}
