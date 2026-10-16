import { useState } from "react";
import { starterPrompt, stages } from "./constants.js";

export default function App() {
  const [prompt, setPrompt] = useState(starterPrompt);

  return (
    <main className="duel-room">
      <header className="room-header">
        <div>
          <span className="status-dot" />
          Live room
        </div>
      </header>

      <section className="prompt-dock">
        <label htmlFor="pitch">Pitch the room</label>
        <textarea
          id="pitch"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={5}
        />
        <p>{stages.length} practice stages ready. The 3D room and shark agents are next.</p>
      </section>
    </main>
  );
}
