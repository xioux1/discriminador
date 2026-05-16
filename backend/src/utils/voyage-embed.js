const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';

export async function createEmbedding(text, model = 'voyage-large-2') {
  const response = await fetch(VOYAGE_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input: [text], model }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Voyage AI embedding failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  return data.data[0].embedding;
}
