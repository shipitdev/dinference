# AI Shark Tank

AI Shark Tank is a desktop/laptop pitch practice room. The user is the founder. Three Nebius-backed model agents act as sharks, ask investor questions, score the user's answers, negotiate, and save a final deal memo in SQLite.

The app follows the Shark Tank format: there is no separate neutral judge. The center/lead seat is the third investor shark, and all three sharks evaluate the founder independently.

## What It Is For

- Practice answering investor questions under pressure.
- Turn one messy business prompt into a structured Shark Tank room.
- See how different investor archetypes react to the same founder answer.
- Save deal memos, offers, passes, risks, and drills for later practice.

## Shark Agents

- `MiniMax Shark`: operator/execution investor using `MiniMaxAI/MiniMax-M3`.
- `DeepSeek Flash Shark`: growth/category investor using `deepseek-ai/DeepSeek-V4-Flash`.
- `Nemotron Lightning Shark`: lead deal-maker and financial skeptic using `nvidia/Nemotron-3_5-Lightning`.

The backend uses Mastra `Agent` objects with Nebius Token Factory through OpenAI-compatible chat completions. There are no local fallback answers. If Nebius or the API key fails, the UI should show the error clearly.

## User Flow

1. The user enters one natural-language business pitch in the bottom dock.
2. `POST /api/room/start` validates `NEBIUS_API_KEY`, extracts business facts, creates shark identities, then asks each shark model to write its own starting questions.
3. The bottom dock becomes an answer composer.
4. For each round, the user submits one answer with `POST /api/room/:id/answer`.
5. All three sharks independently react, score the answer, update investment interest, and give pressure notes.
6. Quick room runs 3 rounds: one question from each shark. Full room runs 6 rounds: two questions from each shark.
7. After the final answer, each shark chooses `offer`, `pass`, or `join`.
8. The final deal memo is saved as `kind: "user-shark-room"`.
9. The user can send one counter-offer with `POST /api/room/:id/counter`; each shark responds with `accept`, `revise`, or `walk`.

## Data Model

Room:

```js
{
  id,
  kind: "user-shark-room",
  status: "awaiting-answer" | "dealing" | "complete",
  businessTitle,
  promptSummary,
  prompt,
  practiceContext,
  sharks,
  rounds,
  currentRoundIndex,
  finalDeal
}
```

Round:

```js
{
  focus,
  panelQuestion,
  userAnswer,
  sharkReactions,
  scores,
  interest
}
```

Final deal:

```js
{
  outcome: "Deal" | "Conditional deal" | "No deal",
  offers,
  bestOffer,
  verdict,
  strongestAnswer,
  weakestAnswer,
  dealRisks,
  nextPractice,
  counterOffer,
  counterOffers
}
```

## Important Files

- `server/index.js`: Express API, Mastra agents, Nebius calls, SQLite persistence, reports.
- `src/hooks/useSimulation.js`: starts rooms, submits answers, sends counter-offers, loads reports.
- `src/components/PitchRoom.jsx`: React Three Fiber stage, seats, camera, lighting.
- `src/components/SpeechCard.jsx`: transparent shark reaction overlays and center panel question.
- `src/components/PromptDock.jsx`: pitch, answer, and counter-offer composer.
- `src/components/ReportModal.jsx`: in-app deal memo.
- `src/components/ReportsLibrary.jsx`: saved report library.
- `src/App.css`: visual design and desktop/laptop layout.
