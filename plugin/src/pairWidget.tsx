import { renderWidget, usePlugin } from "@remnote/plugin-sdk";
import { useState, type FormEvent } from "react";
import { storePairingCode } from "./pairing.js";

export function PairWidget() {
  const plugin = usePlugin();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      storePairingCode(window.localStorage, code);
      setError("");
      await plugin.app.toast("Pairing code saved. RemNoteConnect is completing the local handshake.");
      await plugin.widget.closePopup();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    }
  };

  return (
    <main className="pair-panel">
      <h1>Pair RemNoteConnect</h1>
      <p>Run this command in Terminal:</p>
      <code>node scripts/rnc.mjs pair</code>
      <p>Paste the short-lived code below. It expires after two minutes and is exchanged locally for the real daemon token.</p>
      <form onSubmit={submit}>
        <label htmlFor="pair-code">Pairing code</label>
        <input
          id="pair-code"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="pair-…"
        />
        {error ? <p className="error">{error}</p> : null}
        <button type="submit">Pair locally</button>
      </form>
      <style>{`
        :root { color-scheme: dark light; }
        body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
        .pair-panel { box-sizing: border-box; min-height: 100vh; padding: 24px; color: #f7f7f8; background: #111318; }
        h1 { margin: 0 0 16px; font-size: 21px; }
        p { color: #b7bdc8; font-size: 13px; line-height: 1.5; }
        code { display: block; padding: 10px 12px; border-radius: 8px; color: #d8fff0; background: #1d2630; font-size: 12px; overflow-wrap: anywhere; }
        form { display: grid; gap: 9px; margin-top: 18px; }
        label { font-size: 12px; font-weight: 650; }
        input { box-sizing: border-box; width: 100%; padding: 11px; border: 1px solid #495262; border-radius: 8px; color: #fff; background: #1b1e25; font: inherit; }
        button { justify-self: start; padding: 10px 14px; border: 0; border-radius: 8px; color: #071710; background: #58d6a4; font-weight: 700; cursor: pointer; }
        .error { margin: 0; color: #ffc9ce; }
        @media (prefers-color-scheme: light) {
          .pair-panel { color: #15171b; background: #fafafa; }
          p { color: #555d6b; }
          code { color: #174c39; background: #e7f4ee; }
          input { color: #15171b; background: #fff; border-color: #b7bdc8; }
        }
      `}</style>
    </main>
  );
}

export function renderPairWidget(): void {
  renderWidget(PairWidget);
}
