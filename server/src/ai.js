import "./env.js";

const demoQuestions = [
  "Tell me about yourself and the most relevant project you have built.",
  "Walk me through a difficult technical problem you solved and how you approached it.",
  "How would you design a scalable API for an application with many concurrent users?",
  "What trade-offs would you consider when choosing a database for this role?",
  "Describe a time you received critical feedback. What did you change?",
  "If your production service suddenly became slow, how would you investigate it?"
];

async function openai(messages, temperature = 0.2) {
  const key = process.env.OPENAI_API_KEY;
  if (!key || key.trim() === "") {
    return null;
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${key}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature,
      messages
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error(`OpenAI error (${response.status}):`, errText);
    return null;
  }
  const json = await response.json();
  return json.choices?.[0]?.message?.content || "";
}

export async function generateQuestions({
  role,
  difficulty,
  jobDescription,
  githubSummary,
  language = "en-IN"
}) {
  const prompt = `Create 6 interview questions for a ${difficulty} ${role} candidate.
Job description: ${jobDescription || "General software engineering role"}
Candidate GitHub summary: ${githubSummary || "Not available"}
Language: ${language}

Return ONLY a valid JSON array of 6 question strings.`;

  try {
    const raw = await openai([
      { role: "system", content: "You are an expert technical interviewer." },
      { role: "user", content: prompt }
    ], 0.4);
    if (raw) {
      const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
      if (Array.isArray(parsed) && parsed.length) return parsed.slice(0, 8);
    }
  } catch (err) {
    console.error("Question error:", err.message);
  }
  return demoQuestions;
}

export async function evaluateInterview({ role, transcript }) {
  const text = transcript.map(x => `${x.type}: ${x.content}`).join("\n");

  const systemPrompt = `
You are a strict, no-nonsense Senior Technical Interviewer evaluating a candidate for the role of ${role}.

STRICT SCORING RULES:
1. GIBBERISH / RANDOM TYPING / NONSENSE: If candidate inputs random letters ("iuyghsjkh...", "asdf", single disconnected words), assign a score between 0 and 10 out of 100.
2. VAGUE / SHALLOW: Assign 15 to 40.
3. SOLID / TECHNICAL: Assign 65 to 80.
4. EXCEPTIONAL: Assign 85 to 100.

Return JSON ONLY:
{
  "score": <number 0-100>,
  "summary": "<candid 2-sentence summary>",
  "strengths": ["<strength 1>"],
  "weaknesses": ["<weakness 1>"],
  "improvements": ["<improvement 1>"]
}
`;

  try {
    const raw = await openai([
      { role: "system", content: systemPrompt },
      { role: "user", content: `Evaluate this transcript:\n\n${text}` }
    ], 0.1);

    if (raw) {
      return JSON.parse(raw.replace(/```json|```/g, "").trim());
    }
  } catch (err) {
    console.error("AI Evaluation error:", err.message);
  }

  // Strict offline fallback logic:
  const userMessages = transcript.filter(x => x.type === "User").map(x => x.content.trim());
  let validAnswers = 0;
  for (const msg of userMessages) {
    const words = msg.split(/\s+/);
    if (words.length >= 4 && msg.length > 25) {
      validAnswers++;
    }
  }

  if (validAnswers === 0) {
    return {
      score: 5,
      summary: "Candidate submitted incoherent or invalid answers containing no technical substance.",
      strengths: ["Session completed"],
      weaknesses: ["Responses contained random keyboard typing / non-answers"],
      improvements: ["Provide clear, articulate technical explanations for each question asked"]
    };
  }

  return {
    score: Math.min(45, validAnswers * 8),
    summary: "Responses were brief and lacked technical depth.",
    strengths: ["Attempted answers"],
    weaknesses: ["Lacked architectural detail, trade-offs, and clear structure"],
    improvements: ["Explain core concepts with concrete technical examples"]
  };
}