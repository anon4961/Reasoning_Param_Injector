# Reasoning Param Injector

A SillyTavern (ST) extension that stores `reasoning_effort` / `verbosity` values
**per model** and automatically injects them into requests when you use a
**Custom (OpenAI-compatible) endpoint**.

> it manages reasoning parameters **per model** and slips them into
> your request — even for models ST would not otherwise send them for.

---

## Background Info

### 1) How ST injects reasoning parameters

ST presets have a `Request model reasoning` setting where you choose
`reasoning_effort` (none/minimum/low/medium/high/maximum) and `verbosity`.
ST does **not** send these to every model. Internally it keeps a
**whitelist** (a list of OpenAI-family models), and only sends `reasoning_effort`
upstream when the model name **matches the whitelist exactly**. 

So for a model that is not on the whitelist, picking a reasoning value in the
preset does **nothing** — the value is simply not transmitted.

### 2) ST's official policy on the whitelist

- The list is **OpenAI-family only** (`o1`, `o3`, `gpt-5` series, etc.).
- Therefore **Claude, Gemini, and others are not on the list even with their
  official model names; in that case ST
  does not transmit the reasoning parameters.
(In the case of Velbosity, it is passed if it starts with the official model name without checking for overall consistency.)

### 3) How to handle off-list models

Even for an off-list model, you can bypass the whitelist by writing the value
directly into ST's **Additional Parameters** (`custom_include_body`), e.g.
`reasoning_effort: high`. It then rides along with the request.

The catch: ST manages these Additional Parameters as **a single shared set
across the entire "Custom" provider.** Every time you switch between different
Custom endpoints or change models, you have to manually
rewrite the Additional Parameters field.

**What this extension helps:**
It stores reasoning parameters **per model name** and automatically injects the
right value for the currently connected model, right before the request. No more
editing Additional Parameters every time you switch endpoints or models.

---

## How it works

Right before a request (at ST's `CHAT_COMPLETION_SETTINGS_READY` event), the
extension **auto-checks** the active model name against the whitelist.

- **Whitelisted model** → ST already sends it natively, so the extension
  **does not inject** (adjust via the preset menu instead).
- **Off-list model** → the saved value is **injected** via the Additional
  Parameters path (`custom_include_body`). This behaves identically to typing it
  into the Additional Parameters field yourself.
- `reasoning_effort` and `verbosity` are evaluated and injected **independently.**

> **Important limitation**
> This extension only guarantees that the parameter is **placed into the request
> at the ST side.** It does **not** guarantee that the **server** will actually forward that value to the model. Many
> intermediaries possibly drop or ignore parameters they don't support. So even
> if the log says "injected", whether the value reached the model is a **separate
> matter** that you must verify yourself (see below).

### Reasoning Effort values

The dropdown sends the actual value as-is: `none / minimum / low / medium / high /
maximum`, plus `minimal / xhigh` which are OpenAI-family only. `none` disables
reasoning. If a model doesn't accept the value, the server may reject it — pick a
different value or send the exact one via a custom parameter.

### Auto-mapping (on by default)

Infers the vendor from the model name and adjusts reasoning_effort to a value
that vendor accepts:

- **none**: never converted — sent as-is (preserves "reasoning off")
- **OpenAI** (`gpt`/`o1`/`o3`/`o4`): `minimum→minimal`, `maximum→xhigh`
- **DeepSeek** (`deepseek`): `maximum/xhigh→max`, `everything else→high`
- **Claude** (`claude`): `minimum/minimal→low`, `maximum→max`
- **Others (Gemini, etc.)**: no conversion, sent raw (held back — format unclear)

The result is shown in small text in the active-model box. Turn it off to send
every value raw.

### Add / Exclude parameters (up to 5 each)

Directly control parameters beyond reasoning/verbosity (collapsible menus).
Stored per model name.

- **Add parameters** (key/value): inject arbitrary parameters into the request,
  sent exactly as entered with no auto-mapping. Example: key `thinkingLevel`,
  value `high`.
- **Exclude parameters** (key only): remove that key from the request ST sends
  (deleted from the final body). Example: `frequency_penalty`.

Both are **always applied, even for whitelisted models** (a free-form area). They
may conflict with values ST already sends, so use them at your discretion.

---

## Scope

- **Works only with the Custom (OpenAI-compatible) source.** Other connection
  sources such as Vertex/Gemini/official Claude use a different request path
  inside ST (they do not use `custom_include_body`), so this extension's
  injection does not apply. For those, the panel shows "source not supported",
  and you should adjust reasoning via the preset.

---

## Usage

1. Install the extension and restart ST.
2. Open the **Reasoning Param Injector** drawer in the Extensions panel.
3. **Current connection** shows the active model name and the verdict
   (inject target / ST native / unsupported).
4. Choose **Reasoning Effort / Verbosity** and click **Save for this model.**
   The saved value is auto-injected on future requests with the same model.
5. The **Log** shows injection/skip records (display can be toggled on/off).

> **Turn streaming OFF (non-stream) when inspecting results.** With streaming on,
> the response `usage` (token details) may be missing or hard to read, making it
> difficult to compare reasoning tokens, etc.

---

## Whitelist auto-update

- The **Update from GitHub** button fetches the latest whitelist from ST's
  official repository (it only parses text; it does not execute any code).
- If the update fails, the extension keeps using its built-in list.
- To add a model not on the list, enter exact model names (one per line) in the
  **Manual models** field.

---

## Storage / Safety

- All data is stored in the extension's own **IndexedDB** (`st_param_injector`).
  Per-model settings live in the `models` store, keyed by **model name.**
- Use **Delete all saved model settings** to wipe everything at once.
