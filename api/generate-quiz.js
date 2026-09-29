// Vercel serverless function: provider credentials stay server-side.
const ALLOWED_SUBJECTS = ["History", "Geography", "Political Science", "English", "Hindi"];
const ALLOWED_DIFFICULTIES = ["Easy", "Medium", "Hard", "Mixed"];

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed." }); }
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return res.status(500).json({ error: "AI service is not configured yet. Add OPENROUTER_API_KEY in Vercel Environment Variables." });
  try {
    const { subject, chapter, scope, count, difficulty } = req.body || {};
    if (!ALLOWED_SUBJECTS.includes(subject)) return res.status(400).json({ error: "Select a valid subject." });
    if (!["chapter", "subject"].includes(scope)) return res.status(400).json({ error: "Select a quiz scope." });
    if (scope === "chapter" && (typeof chapter !== "string" || !chapter.trim())) return res.status(400).json({ error: "Select a chapter." });
    if (![5,10,15,20].includes(Number(count))) return res.status(400).json({ error: "Invalid question count." });
    if (!ALLOWED_DIFFICULTIES.includes(difficulty)) return res.status(400).json({ error: "Invalid difficulty." });
    const n = Number(count);
    const target = scope === "chapter" ? "chapter: " + chapter : "the full Class XII CBSE syllabus";
    const lang = subject === "Hindi" ? "Hindi" : "English";
    const prompt = `Create exactly ${n} original, accurate CBSE Class 12 Humanities MCQs for ${subject}, covering ${target}. Difficulty: ${difficulty}. Language: ${lang}. Align with NCERT/CBSE concepts; do not claim these are official past-paper questions. Make questions distinct. In full-subject mode, spread across relevant chapters and provide chapter for each. Each question needs four plausible options, exactly one correct answer, and a concise explanation. Mixed means a balanced mix of easy, medium, hard. For Hindi, write questions/options in Hindi. Return ONLY JSON: {"questions":[{"question":"...","options":["...","...","...","..."],"correctIndex":0,"explanation":"...","difficulty":"Easy","chapter":"..."}]}`;
    const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST", headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ model: process.env.OPENROUTER_MODEL || "openrouter/free", messages: [{ role:"system", content:"You are a careful CBSE Class XII question setter. Follow the JSON schema exactly; accuracy matters more than creativity." }, { role:"user", content:prompt }], temperature:0.7, max_tokens:Math.min(7500,n*330), stream:false })
    });
    const raw = await upstream.text();
    if (!upstream.ok) { console.error("OpenRouter API error", upstream.status, raw.slice(0,1000)); return res.status(502).json({ error:"The AI provider could not generate questions. Please try again." }); }
    const data = JSON.parse(raw);
    const message = data.choices?.[0]?.message;
    let content = message?.content;
    if (Array.isArray(content)) content = content.map(part => typeof part === "string" ? part : (part?.text || "")).join("\n");
    if (typeof content !== "string" || !content.trim()) throw new Error("Empty AI response");

    // Models may wrap JSON in markdown or add a short preface.
    const clean = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch {
      const firstBrace = clean.indexOf("{");
      const lastBrace = clean.lastIndexOf("}");
      if (firstBrace < 0 || lastBrace <= firstBrace) throw new Error("AI response did not contain a JSON object");
      parsed = JSON.parse(clean.slice(firstBrace, lastBrace + 1));
    }
    const list = parsed?.questions;
    if (!Array.isArray(list) || list.length !== n) throw new Error("Wrong question count");
    const valid = list.every(q => q && typeof q.question === "string" && q.question.trim() && Array.isArray(q.options) && q.options.length === 4 && q.options.every(x => typeof x === "string" && x.trim()) && Number.isInteger(q.correctIndex) && q.correctIndex >= 0 && q.correctIndex < 4 && typeof q.explanation === "string" && q.explanation.trim());
    if (!valid) throw new Error("Invalid question structure");
    return res.status(200).json({ questions:list.map(q => ({ question:q.question.trim(), options:q.options.map(x=>x.trim()), correctIndex:q.correctIndex, explanation:q.explanation.trim(), difficulty:["Easy","Medium","Hard"].includes(q.difficulty)?q.difficulty:(difficulty==="Mixed"?"Medium":difficulty), chapter:typeof q.chapter==="string"?q.chapter:(chapter||"Full subject") })) });
  } catch (e) { console.error("Quiz generation error",e); return res.status(502).json({ error:"The AI returned an invalid response. Please try again." }); }
}