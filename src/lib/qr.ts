export function qrImageSource(value: string): string {
  const raw = value.trim();
  if (!raw) return "";

  // Supabase currently returns raw SVG, but keep already-usable image sources intact.
  if (/^(data:image\/|blob:|https?:\/\/)/i.test(raw)) return raw;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(raw)}`;
}
