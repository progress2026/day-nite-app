// Vercel serverless function: /api/scan
// Recibe { imageBase64, mediaType } y devuelve los campos del envío ya leídos.
// La API key de Claude vive SOLO aquí en el servidor (nunca llega al navegador).

const PROMPT =
  "This is a business shipping document: a receipt, packing list/slip, bill of lading, label, or shipping confirmation. Extract the information and respond with ONLY a valid JSON object, no text before or after, no markdown, no backticks:\n" +
  "{\n" +
  '  "workOrder": "work order number (W.O #) if present, else empty string",\n' +
  '  "customer": "customer / sold-to / project site brand, e.g. Tim Hortons, Irving Oil",\n' +
  '  "lineItems": [ { "qty": "quantity as written, e.g. 2", "description": "item description" } ],\n' +
  '  "destination": "where it shipped to: ship-to address/consignee",\n' +
  '  "date": "shipping date as YYYY-MM-DD if determinable, else empty string",\n' +
  '  "carrier": "shipping carrier or issuing company, e.g. Purolator, FedEx, Day & Ross",\n' +
  '  "trackingNumber": "tracking, quote, or purchase order number if present, else empty string",\n' +
  '  "notes": "other useful details: sold-to/project site, weight, dimensions, reference, special instructions, in one short phrase"\n' +
  "}\n" +
  "Include every line of the items table in lineItems (one object per row). If a field cannot be determined, use an empty string. Do not invent data. Respond with the JSON only.";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST with { imageBase64, mediaType }." });
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY is not configured on the server." });
  }

  const { imageBase64, mediaType } = req.body || {};
  if (!imageBase64) {
    return res.status(400).json({ error: "Missing imageBase64." });
  }

  const isPdf = mediaType === "application/pdf";
  const mediaBlock = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: imageBase64 } }
    : { type: "image", source: { type: "base64", media_type: mediaType || "image/jpeg", data: imageBase64 } };

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        messages: [{ role: "user", content: [mediaBlock, { type: "text", text: PROMPT }] }],
      }),
    });

    const raw = await r.text();
    if (!r.ok) {
      return res.status(502).json({ error: `AI error ${r.status}`, detail: raw.slice(0, 300) });
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return res.status(502).json({ error: "AI returned non-JSON." });
    }

    let text = Array.isArray(data.content)
      ? data.content.map((b) => (typeof b === "string" ? b : b?.text || "")).join("\n")
      : "";
    text = (text || "").trim();
    if (!text) return res.status(502).json({ error: "AI returned no text." });

    let clean = text.replace(/```json|```/g, "").trim();
    const a = clean.indexOf("{");
    const b = clean.lastIndexOf("}");
    if (a !== -1 && b !== -1 && b > a) clean = clean.slice(a, b + 1);

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch {
      return res.status(502).json({ error: "Could not parse the document fields.", raw: text.slice(0, 200) });
    }

    return res.status(200).json({
      workOrder: parsed.workOrder || "",
      customer: parsed.customer || "",
      lineItems: Array.isArray(parsed.lineItems) ? parsed.lineItems : [],
      destination: parsed.destination || "",
      date: parsed.date || "",
      carrier: parsed.carrier || "",
      trackingNumber: parsed.trackingNumber || "",
      notes: parsed.notes || "",
    });
  } catch (e) {
    return res.status(502).json({ error: "Request to AI failed: " + (e?.message || "unknown") });
  }
}
