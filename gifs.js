const TENOR_KEY = "LIVDSRZULELA";

const QUERIES = [
  "mob rage",
  "mob psycho 100 rage",
  "shigeo kageyama rage",
  "mob psycho 100 angry",
];

export async function fetchMobGif() {
  try {
    const q = QUERIES[Math.floor(Math.random() * QUERIES.length)];
    const res = await fetch(
      `https://api.tenor.com/v1/search?q=${encodeURIComponent(q)}&key=${TENOR_KEY}&limit=20&contentfilter=medium&media_filter=basic`
    );
    if (!res.ok) return null;

    const data = await res.json();
    if (!data.results?.length) return null;

    const pick = data.results[Math.floor(Math.random() * data.results.length)];
    const media = pick.media?.[0];
    return media?.gif?.url || media?.tinygif?.url || null;
  } catch {
    return null;
  }
}
