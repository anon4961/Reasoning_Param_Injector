/*
 * Reasoning Param Injector v1.0.0 *
 */

(function () {
    'use strict';

    const LOG_PREFIX = '[ParamInjector]';

    // ── ST 화이트리스트 사본 (ST 1.18.0 src/constants.js 기준) ───────────
    const ST_REASONING_EFFORT_MODELS_DEFAULT = [
        'o1', 'o3-mini', 'o3-mini-2025-01-31', 'o4-mini', 'o4-mini-2025-04-16',
        'o3', 'o3-2025-04-16',
        'gpt-5', 'gpt-5-2025-08-07', 'gpt-5-mini', 'gpt-5-mini-2025-08-07',
        'gpt-5-nano', 'gpt-5-nano-2025-08-07',
        'gpt-5.1', 'gpt-5.1-2025-11-13', 'gpt-5.1-chat-latest',
        'gpt-5.2', 'gpt-5.2-2025-12-11', 'gpt-5.2-chat-latest',
        'gpt-5.3-chat-latest',
        'gpt-5.4', 'gpt-5.4-2026-03-05', 'gpt-5.4-mini', 'gpt-5.4-mini-2026-03-17',
        'gpt-5.4-nano', 'gpt-5.4-nano-2026-03-17',
        'gpt-5.5', 'gpt-5.5-2026-04-23',
    ];
    const ST_VERBOSITY_REGEX = /^gpt-5/;

    const REASONING_OPTIONS = ['보내지 않기', 'auto', 'minimum', 'low', 'medium', 'high', 'maximum'];
    const VERBOSITY_OPTIONS = ['보내지 않기', 'auto', 'low', 'medium', 'high'];
    const NO_SEND_LABELS = ['보내지 않기', 'auto'];

    // ── IndexedDB ───────────────────────────────────────────────────────
    const DB_NAME = 'st_param_injector';
    const DB_VERSION = 2;
    const STORE_MODELS = 'models'; // key: model -> {reasoning, verbosity, updatedAt}
    const STORE_LOGS = 'logs';
    const STORE_META = 'meta';

    let _db = null;

    function openDB() {
        return new Promise((resolve, reject) => {
            try {
                const req = indexedDB.open(DB_NAME, DB_VERSION);
                req.onupgradeneeded = (e) => {
                    const db = e.target.result;
                    if (!db.objectStoreNames.contains(STORE_MODELS)) {
                        db.createObjectStore(STORE_MODELS, { keyPath: 'model' });
                    }
                    if (!db.objectStoreNames.contains(STORE_LOGS)) {
                        db.createObjectStore(STORE_LOGS, { keyPath: 'id', autoIncrement: true });
                    }
                    if (!db.objectStoreNames.contains(STORE_META)) {
                        db.createObjectStore(STORE_META, { keyPath: 'key' });
                    }
                };
                req.onsuccess = (e) => resolve(e.target.result);
                req.onerror = (e) => reject(e.target.error);
            } catch (err) { reject(err); }
        });
    }
    async function getDB() { if (_db) return _db; _db = await openDB(); return _db; }
    function txStore(store, mode) { return getDB().then((db) => db.transaction(store, mode).objectStore(store)); }
    function idbReq(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }
    async function dbGet(store, key) { return idbReq((await txStore(store, 'readonly')).get(key)); }
    async function dbPut(store, value) { return idbReq((await txStore(store, 'readwrite')).put(value)); }
    async function dbDelete(store, key) { return idbReq((await txStore(store, 'readwrite')).delete(key)); }
    async function dbGetAll(store) { return idbReq((await txStore(store, 'readonly')).getAll()); }
    async function dbClear(store) { return idbReq((await txStore(store, 'readwrite')).clear()); }
    async function dbCount(store) { return idbReq((await txStore(store, 'readonly')).count()); }

    async function metaGet(key, fallback) {
        try { const row = await dbGet(STORE_META, key); return row ? row.value : fallback; }
        catch (e) { return fallback; }
    }
    async function metaSet(key, value) {
        try { await dbPut(STORE_META, { key, value }); } catch (e) { /* noop */ }
    }

    // ── 로그 ────────────────────────────────────────────────────────────
    let logMaxKeep = 200;

    async function addLog(entry) {
        try {
            entry.ts = Date.now();
            await dbPut(STORE_LOGS, entry);
            const count = await dbCount(STORE_LOGS);
            if (count > logMaxKeep) {
                const all = await dbGetAll(STORE_LOGS);
                const removeCount = count - logMaxKeep;
                for (let i = 0; i < removeCount; i++) {
                    if (all[i] && all[i].id != null) await dbDelete(STORE_LOGS, all[i].id);
                }
            }
        } catch (e) { console.warn(LOG_PREFIX, '로그 기록 실패:', e); }
        try { if (isLogVisible()) renderLogs(); } catch (e) { /* noop */ }
    }

    // ── ST 컨텍스트 ─────────────────────────────────────────────────────
    function getCtx() {
        try {
            return (typeof SillyTavern !== 'undefined' && SillyTavern.getContext)
                ? SillyTavern.getContext() : null;
        } catch (e) { return null; }
    }

    function getActiveProfile() {
        try {
            const ctx = getCtx();
            const mgr = ctx && ctx.extensionSettings && ctx.extensionSettings.connectionManager;
            if (!mgr || !Array.isArray(mgr.profiles)) return null;
            const selId = mgr.selectedProfile;
            if (!selId) return null;
            return mgr.profiles.find((p) => p && p.id === selId) || null;
        } catch (e) { return null; }
    }

    // 현재 활성 모델명 — generate_data.model 우선, getChatCompletionModel, 프로필 순
    function getActiveModel(generate_data) {
        try {
            if (generate_data && generate_data.model) return String(generate_data.model);
            const ctx = getCtx();
            if (ctx && typeof ctx.getChatCompletionModel === 'function') {
                const m = ctx.getChatCompletionModel();
                if (m) return String(m);
            }
            const p = getActiveProfile();
            if (p && p.model) return String(p.model);
        } catch (e) { /* noop */ }
        return '';
    }

    function getSource() {
        try {
            const ctx = getCtx();
            return ctx && ctx.chatCompletionSettings
                ? ctx.chatCompletionSettings.chat_completion_source : undefined;
        } catch (e) { return undefined; }
    }

    // ── 화이트리스트 판별 ───────────────────────────────────────────────
    async function getReasoningWhitelist() {
        const extra = await metaGet('reasoning_whitelist_extra', []);
        const fetched = await metaGet('reasoning_whitelist_fetched', null);
        // 자동 갱신분이 있으면 그것을 기반으로, 없으면 내장 기본값
        const base = (Array.isArray(fetched) && fetched.length)
            ? fetched : ST_REASONING_EFFORT_MODELS_DEFAULT;
        const set = new Set(base);
        if (Array.isArray(extra)) extra.forEach((m) => { if (m) set.add(String(m).trim()); });
        return set;
    }
    // verbosity 판별 정규식 — 자동 갱신분이 있으면 사용, 없으면 내장
    async function getVerbosityRegex() {
        const src = await metaGet('verbosity_regex_fetched', null);
        if (src) {
            try { return new RegExp(src); } catch (e) { /* 잘못된 패턴이면 폴백 */ }
        }
        return ST_VERBOSITY_REGEX;
    }
    async function classifyModel(modelName) {
        const name = (modelName || '').trim();
        const wl = await getReasoningWhitelist();
        const vre = await getVerbosityRegex();
        return {
            reasoningNative: wl.has(name),
            verbosityNative: vre.test(name),
        };
    }

    // ── 화이트리스트 자동 갱신 (GitHub raw, CORS 허용 확인됨) ────────────
    // ST 공식 저장소의 src/constants.js 에서 두 정의를 정규식으로 추출한다.
    // JS 를 실행하지 않고 텍스트 파싱만 한다(안전). 실패 시 기존 값 유지.
    const ST_CONSTANTS_URL = 'https://raw.githubusercontent.com/SillyTavern/SillyTavern/release/src/constants.js';

    async function fetchWhitelistFromGitHub() {
        const res = await fetch(ST_CONSTANTS_URL, { method: 'GET' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const text = await res.text();

        // OPENAI_REASONING_EFFORT_MODELS = [ ... ];
        const arrMatch = text.match(/OPENAI_REASONING_EFFORT_MODELS\s*=\s*\[([\s\S]*?)\]/);
        let models = null;
        if (arrMatch) {
            models = (arrMatch[1].match(/'([^']+)'|"([^"]+)"/g) || [])
                .map((s) => s.replace(/['"]/g, '').trim())
                .filter(Boolean);
        }

        // OPENAI_VERBOSITY_MODELS = /regex/;
        const reMatch = text.match(/OPENAI_VERBOSITY_MODELS\s*=\s*\/((?:[^/\\]|\\.)*)\//);
        const verbosityRe = reMatch ? reMatch[1] : null;

        if (!models || models.length === 0) {
            throw new Error('reasoning 목록 파싱 실패(구조 변경 가능)');
        }
        // verbosity 정규식은 유효성 검사
        if (verbosityRe) {
            try { new RegExp(verbosityRe); } catch (e) { /* 무효면 저장 안 함 */ }
        }
        return { models, verbosityRe };
    }

    // ── 주입 핵심부 ─────────────────────────────────────────────────────

    async function onSettingsReady(generate_data) {
        try {
            if (!generate_data || typeof generate_data !== 'object') return;

            const model = getActiveModel(generate_data);
            const source = getSource();
            const cls = await classifyModel(model);

            // ── 일반 주입: 모델 저장값 로드 ──
            if (!model) return;

            // 소스 가드: custom_include_body 병합은 CUSTOM(OpenAI-compatible)
            // 소스에서만 동작한다(ST 1.18.0 검증). Vertex/Gemini/Claude 등 다른
            // 소스는 별도 요청 경로라 custom_include_body 를 무시하므로, 주입해도
            // 효과가 없다. 잘못된 "주입 성공" 신호를 막기 위해 여기서 중단한다.
            if (source !== 'custom') {
                const saved0 = await dbGet(STORE_MODELS, model);
                if (saved0 && ((saved0.reasoning && !NO_SEND_LABELS.includes(saved0.reasoning))
                    || (saved0.verbosity && !NO_SEND_LABELS.includes(saved0.verbosity)))) {
                    await addLog({
                        type: 'inject', model, source: source || '(unknown)',
                        injected: {}, skipped: { _source: 'custom 소스 아님 — 주입 경로 없음' },
                        note: `이 연결 소스(${source || '?'})는 Custom(OpenAI 호환)이 아니라서 확장 주입이 적용되지 않습니다. `
                            + 'reasoning_effort/verbosity는 프리셋 메뉴에서 직접 조절하세요.',
                    });
                }
                return;
            }

            const saved = await dbGet(STORE_MODELS, model);
            if (!saved) return;

            const log = {
                type: 'inject', model, source: source || '(unknown)',
                injected: {}, skipped: {}, note: '',
            };
            const notes = [];

            // ── 주입 방식 (ST 1.18.0 검증 결과 반영) ──
            // 서버는 generate_data.reasoning_effort 를 "화이트리스트 통과 모델"
            // 에서만 상위로 전달한다(미통과면 버림). 반면 custom_include_body 는
            // 화이트리스트와 무관하게 그대로 병합·전송된다 = 추가 파라미터 칸에
            // 직접 쓴 것과 100% 동일. 그래서 미통과 모델은 custom_include_body 로
            // 주입한다.
            //   - 통과 모델: 손대지 않음(ST가 이미 정식 전송 / 우리가 또 넣으면 충돌)
            //   - 미통과 모델: custom_include_body 에 우리 값을 추가
            //       단, 사용자가 이미 같은 키를 써뒀으면 충돌 → 추가 안 하고 경고

            let cib = (typeof generate_data.custom_include_body === 'string')
                ? generate_data.custom_include_body : '';

            // reasoning_effort
            if (saved.reasoning && !NO_SEND_LABELS.includes(saved.reasoning)) {
                const key = 'reasoning_effort';
                if (cls.reasoningNative) {
                    log.skipped[key] = '화이트리스트 통과(ST 자체 전송) — 프리셋에서 조절';
                    notes.push('reasoning_effort: 이 모델은 ST가 자체 전송하므로 주입하지 않음(중복 주입 시 충돌 위험). 프리셋에서 조절하세요.');
                } else if (yamlHasTopKey(cib, key)) {
                    log.skipped[key] = '추가 파라미터에 이미 존재 — 사용자 설정 우선';
                    notes.push('reasoning_effort: 추가 파라미터(custom_include_body)에 이미 있어 건드리지 않음.');
                } else {
                    cib = yamlAddTopKey(cib, key, saved.reasoning);
                    log.injected[key] = saved.reasoning;
                    notes.push('reasoning_effort 주입함(추가 파라미터 경로). 실제 모델 전달 여부는 Termux에서 확인하세요.');
                }
            }

            // verbosity
            if (saved.verbosity && !NO_SEND_LABELS.includes(saved.verbosity)) {
                const key = 'verbosity';
                if (cls.verbosityNative) {
                    log.skipped[key] = '화이트리스트 통과(ST 자체 전송) — 프리셋에서 조절';
                    notes.push('verbosity: 이 모델은 ST가 자체 전송하므로 주입하지 않음(중복 주입 시 충돌 위험). 프리셋에서 조절하세요.');
                } else if (yamlHasTopKey(cib, key)) {
                    log.skipped[key] = '추가 파라미터에 이미 존재 — 사용자 설정 우선';
                    notes.push('verbosity: 추가 파라미터(custom_include_body)에 이미 있어 건드리지 않음.');
                } else {
                    cib = yamlAddTopKey(cib, key, saved.verbosity);
                    log.injected[key] = saved.verbosity;
                    notes.push('verbosity 주입함(추가 파라미터 경로). 실제 모델 전달 여부는 Termux에서 확인하세요.');
                }
            }

            // 변경분을 generate_data 에 반영 (주입된 게 있을 때만)
            if (Object.keys(log.injected).length > 0) {
                generate_data.custom_include_body = cib;
            }

            log.note = notes.join(' / ');

            if (Object.keys(log.injected).length > 0 || Object.keys(log.skipped).length > 0) {
                await addLog(log);
            }
        } catch (err) {
            console.warn(LOG_PREFIX, 'onSettingsReady 오류(무시하고 정상 전송):', err);
            try { await addLog({ type: 'error', note: '주입 중 오류: ' + (err && err.message ? err.message : String(err)) }); }
            catch (e) { /* noop */ }
        }
    }

    // ── custom_include_body (YAML 문자열) 안전 조작 ─────────────────────
    // ST 서버는 custom_include_body 를 yaml.parse 한 뒤 bodyParams 에
    // Object.assign 한다(화이트리스트 우회). 즉 추가 파라미터 칸에 직접
    // 쓴 것과 동일하게 동작한다. 우리는 파서 없이, 최상위 "key: value" 한
    // 줄 단위로만 안전하게 다룬다(중첩/복잡 YAML 은 건드리지 않는다).

    // 최상위에 key 가 이미 정의돼 있는지 검사 (주석/들여쓰기 줄 제외)
    function yamlHasTopKey(yamlStr, key) {
        if (!yamlStr) return false;
        const lines = String(yamlStr).split(/\r?\n/);
        const re = new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:');
        for (const line of lines) {
            // 들여쓰기(하위 키)나 주석은 최상위로 보지 않음
            if (/^\s/.test(line)) continue;
            if (/^\s*#/.test(line)) continue;
            if (re.test(line.trim()) && !/^\s/.test(line)) return true;
        }
        return false;
    }

    // 최상위에 "key: value" 한 줄을 추가한 새 문자열 반환
    function yamlAddTopKey(yamlStr, key, value) {
        const base = (yamlStr || '').replace(/\s*$/, '');
        const line = `${key}: ${value}`;
        return base ? (base + '\n' + line) : line;
    }

    // ── UI 유틸 ─────────────────────────────────────────────────────────
    // help 물음표: 탭하면 설명을 아래에 펼침/접음 (모바일 hover 없음 대응)
    function bindHelpToggle() {
        try {
            const panel = document.getElementById('pi_panel');
            if (!panel) return;
            const handler = (e) => {
                const tgt = e.target;
                if (!tgt || !tgt.classList || !tgt.classList.contains('pi-help')) return;
                e.preventDefault();
                e.stopPropagation();
                const text = tgt.getAttribute('data-help') || '';
                // 이 아이콘이 이미 연 박스가 있으면 토글로 닫기
                const wasOpen = tgt.getAttribute('data-open') === '1';
                // 열려있는 모든 설명 닫고 표식 초기화(한 번에 하나만)
                panel.querySelectorAll('.pi-help-box').forEach((el) => el.remove());
                panel.querySelectorAll('.pi-help[data-open="1"]').forEach((el) => el.removeAttribute('data-open'));
                if (wasOpen) return; // 같은 아이콘 재탭 → 닫기만 하고 끝
                const boxEl = document.createElement('div');
                boxEl.className = 'pi-help-box';
                boxEl.textContent = text;
                const label = tgt.closest('.pi-label') || tgt.parentElement;
                if (label && label.parentElement) {
                    label.parentElement.insertBefore(boxEl, label.nextSibling);
                } else {
                    tgt.insertAdjacentElement('afterend', boxEl);
                }
                tgt.setAttribute('data-open', '1');
            };
            panel.addEventListener('click', handler);
            panel.addEventListener('keydown', (e) => {
                if ((e.key === 'Enter' || e.key === ' ') && e.target.classList
                    && e.target.classList.contains('pi-help')) {
                    handler(e);
                }
            });
        } catch (e) { console.warn(LOG_PREFIX, 'help 바인딩 오류:', e); }
    }

    function toast(msg, level) {
        try {
            if (typeof toastr !== 'undefined') { (toastr[level] || toastr.info)(msg, 'Reasoning Param Injector'); return; }
        } catch (e) { /* noop */ }
        console.log(LOG_PREFIX, msg);
    }
    function isLogVisible() {
        const el = document.getElementById('pi_log_box');
        return el && el.style.display !== 'none';
    }
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function help(text) {
        return `<span class="pi-help" role="button" tabindex="0" data-help="${esc(text)}">?</span>`;
    }
    function buildSelect(id, options, current) {
        const opts = options.map((o) =>
            `<option value="${esc(o)}"${o === current ? ' selected' : ''}>${esc(o)}</option>`).join('');
        return `<select id="${id}" class="pi-select text_pole">${opts}</select>`;
    }

    // ── 패널 ────────────────────────────────────────────────────────────
    async function buildPanelHTML() {
        const logVisible = await metaGet('log_visible', false);
        logMaxKeep = await metaGet('log_max_keep', 200);
        const extraWl = await metaGet('reasoning_whitelist_extra', []);

        return `
<div id="pi_panel">
  <div class="pi-section">
    <label class="pi-label">현재 연결
      ${help('현재 연결된 활성 모델 자동 감지. 설정값은 "모델명" 기준으로 저장됨.')}
    </label>
    <div id="pi_active" class="pi-active-box">감지 중…</div>
  </div>

  <div class="pi-section">
    <label class="pi-label">Reasoning Effort
      ${help('이 모델로 요청할 때 reasoning_effort 값을 주입합니다. 요청 직전 자동 판독: 이 모델이 ST 화이트리스트를 통과(=ST 자체 전송)하면 주입하지 않고 로그로 안내합니다. 미통과 모델에만 주입합니다.')}
    </label>
    ${buildSelect('pi_reasoning', REASONING_OPTIONS, '보내지 않기')}
  </div>

  <div class="pi-section">
    <label class="pi-label">Verbosity
      ${help('이 모델로 요청할 때 verbosity 값을 주입합니다. 이 모델이 ST 화이트리스트를 통과(=ST 자체 전송)하면 주입하지 않고 로그로 안내합니다. 미통과 모델에만 주입합니다.')}
    </label>
    ${buildSelect('pi_verbosity', VERBOSITY_OPTIONS, '보내지 않기')}
  </div>

  <div class="pi-row">
    <button id="pi_save" class="menu_button">이 모델에 저장</button>
    <button id="pi_clear_model" class="menu_button">이 모델 설정 삭제</button>
  </div>
  <div class="pi-row">
    <button id="pi_clear_all" class="menu_button pi-danger">저장된 모든 모델 설정 삭제</button>
  </div>

  <hr class="pi-hr">

  <div class="pi-section">
    <label class="pi-label">로그
      ${help('주입/스킵/판독 내역은 항상 IndexedDB에 기록됩니다. 보관 개수를 초과하면 오래된 것부터 자동 삭제됩니다.')}
    </label>
    <div class="pi-row pi-row-wrap">
      <label class="pi-check"><input type="checkbox" id="pi_log_toggle"${logVisible ? ' checked' : ''}> 로그 표시</label>
      <span class="pi-sub">보관 개수</span>
      <input id="pi_log_keep" class="text_pole pi-input-sm" type="number" min="10" max="2000" value="${esc(logMaxKeep)}">
      <button id="pi_log_keep_save" class="menu_button">적용</button>
    </div>
    <div class="pi-row">
      <button id="pi_log_refresh" class="menu_button">새로고침</button>
      <button id="pi_log_clear" class="menu_button">로그 전체 비우기</button>
    </div>
    <div id="pi_log_box" class="pi-logbox" style="display:${logVisible ? 'block' : 'none'}"></div>
  </div>

  <hr class="pi-hr">

  <div class="pi-section">
    <label class="pi-label">화이트리스트
      ${help('OpenAI 계열 모델 중 ST가 reasoning_effort를 자체 전송하는 목록입니다. 자동 갱신은 ST 공식 저장소(GitHub)에서 최신 목록을 받아옵니다. 실패하면 내장 목록을 그대로 사용합니다.')}
    </label>
    <div class="pi-row">
      <button id="pi_wl_fetch" class="menu_button">GitHub에서 자동 갱신</button>
    </div>
    <div id="pi_wl_status" class="pi-status"></div>
    <label class="pi-label" style="margin-top:8px;">수동 추가 모델
      ${help('자동 갱신이 실패하거나, 목록에 없는 모델을 직접 추가하고 싶을 때 사용합니다. 한 줄에 하나씩, 정확한 모델명을 입력하세요.')}
    </label>
    <textarea id="pi_wl_extra" class="text_pole pi-textarea" rows="3" placeholder="예: gpt-5.6">${esc((extraWl || []).join('\n'))}</textarea>
    <div class="pi-row"><button id="pi_wl_save" class="menu_button">수동 목록 저장</button></div>
  </div>
</div>`;
    }

    async function updateActiveInfo() {
        try {
            const box = document.getElementById('pi_active');
            if (!box) return;
            const model = getActiveModel(null);
            const source = getSource();
            if (!model) { box.innerHTML = '<span class="pi-dim">활성 모델을 감지하지 못했습니다.</span>'; return; }
            const cls = await classifyModel(model);

            // 소스가 custom 이 아니면 주입 경로가 없음 — 명확히 안내
            const isCustom = (source === 'custom');
            let tagRow;
            if (!isCustom) {
                tagRow = `<div class="pi-tag-row"><span class="pi-tag pi-tag-native">이 소스는 미지원</span> `
                    + `<span class="pi-dim">Custom(OpenAI 호환) 소스에서만 동작합니다. 프리셋에서 조절하세요.</span></div>`;
            } else {
                const rTag = cls.reasoningNative
                    ? '<span class="pi-tag pi-tag-native">ST 자체 전송</span>'
                    : '<span class="pi-tag pi-tag-inject">주입 대상</span>';
                const vTag = cls.verbosityNative
                    ? '<span class="pi-tag pi-tag-native">ST 자체 전송</span>'
                    : '<span class="pi-tag pi-tag-inject">주입 대상</span>';
                tagRow = `<div class="pi-tag-row">reasoning ${rTag} &nbsp; verbosity ${vTag}</div>`;
            }

            // 이 모델에 저장된 값 명시 표시 (추측이 아니라 직접 보여줌)
            let savedLine;
            const saved = await dbGet(STORE_MODELS, model);
            if (saved && (saved.reasoning || saved.verbosity)) {
                savedLine = `<div class="pi-saved">저장됨 · reasoning: <b>${esc(saved.reasoning || '보내지 않기')}</b>, `
                    + `verbosity: <b>${esc(saved.verbosity || '보내지 않기')}</b></div>`;
            } else {
                savedLine = '<div class="pi-saved pi-dim">이 모델에 저장된 설정 없음</div>';
            }

            box.innerHTML =
                `<div class="pi-active-model">${esc(model)}<span class="pi-dim"> · ${esc(source || '')}</span></div>`
                + tagRow
                + savedLine;
            await loadModelIntoForm(model);
        } catch (e) { console.warn(LOG_PREFIX, 'updateActiveInfo 오류:', e); }
    }

    async function loadModelIntoForm(model) {
        try {
            const saved = model ? await dbGet(STORE_MODELS, model) : null;
            const r = document.getElementById('pi_reasoning');
            const v = document.getElementById('pi_verbosity');
            if (r) r.value = (saved && saved.reasoning) || '보내지 않기';
            if (v) v.value = (saved && saved.verbosity) || '보내지 않기';
        } catch (e) { console.warn(LOG_PREFIX, '폼 로드 오류:', e); }
    }

    async function renderLogs() {
        try {
            const box = document.getElementById('pi_log_box');
            if (!box) return;
            const all = await dbGetAll(STORE_LOGS);
            if (!all || all.length === 0) { box.innerHTML = '<div class="pi-log-empty">기록 없음</div>'; return; }
            all.sort((a, b) => (b.ts || 0) - (a.ts || 0));
            const rows = all.slice(0, 100).map((e) => {
                const t = new Date(e.ts || 0).toLocaleString();
                let head;
                if (e.type === 'error') head = '⚠️ 오류';
                else head = '주입/판독';
                const inj = e.injected && Object.keys(e.injected).length
                    ? `<div class="pi-log-inj">주입: ${esc(JSON.stringify(e.injected))}</div>` : '';
                const skp = (e.skipped && typeof e.skipped === 'object' && Object.keys(e.skipped).length)
                    ? `<div class="pi-log-skip">스킵: ${esc(JSON.stringify(e.skipped))}</div>`
                    : (e.skipped === true ? `<div class="pi-log-skip">스킵됨</div>` : '');
                const note = e.note ? `<div class="pi-log-note">${esc(e.note)}</div>` : '';
                const meta = (e.model || e.source)
                    ? `<div class="pi-log-meta">${esc(e.model || '')} · ${esc(e.source || '')}</div>` : '';
                return `<div class="pi-log-item"><div class="pi-log-head">${head}<span class="pi-log-ts">${esc(t)}</span></div>${meta}${inj}${skp}${note}</div>`;
            }).join('');
            box.innerHTML = rows;
        } catch (e) { console.warn(LOG_PREFIX, '로그 렌더 오류:', e); }
    }

    function bindEvents() {
        const $ = (id) => document.getElementById(id);

        const save = $('pi_save');
        if (save) save.addEventListener('click', async () => {
            try {
                const model = getActiveModel(null);
                if (!model) { toast('활성 모델을 감지하지 못해 저장할 수 없습니다.', 'warning'); return; }
                const reasoning = $('pi_reasoning') ? $('pi_reasoning').value : '보내지 않기';
                const verbosity = $('pi_verbosity') ? $('pi_verbosity').value : '보내지 않기';
                await dbPut(STORE_MODELS, { model, reasoning, verbosity, updatedAt: Date.now() });
                toast(`모델 "${model}"에 저장했습니다.`, 'success');
                await updateActiveInfo();
            } catch (e) { toast('저장 실패: ' + e.message, 'error'); }
        });

        const clearM = $('pi_clear_model');
        if (clearM) clearM.addEventListener('click', async () => {
            try {
                const model = getActiveModel(null);
                if (!model) return;
                await dbDelete(STORE_MODELS, model);
                await loadModelIntoForm(model);
                toast(`모델 "${model}" 설정을 삭제했습니다.`, 'info');
                await updateActiveInfo();
            } catch (e) { toast('삭제 실패: ' + e.message, 'error'); }
        });

        const clearAll = $('pi_clear_all');
        if (clearAll) clearAll.addEventListener('click', async () => {
            if (!confirm('정말 모든 모델 설정을 삭제할까요? 되돌릴 수 없습니다.')) return;
            try {
                const all = await dbGetAll(STORE_MODELS);
                const n = all ? all.length : 0;
                await dbClear(STORE_MODELS);
                await loadModelIntoForm(getActiveModel(null));
                await updateActiveInfo();
                toast(`저장된 모델 설정 ${n}개를 모두 삭제했습니다.`, 'info');
            } catch (e) { toast('전체 삭제 실패: ' + e.message, 'error'); }
        });

        const logToggle = $('pi_log_toggle');
        if (logToggle) logToggle.addEventListener('change', async () => {
            const box = $('pi_log_box'); const on = logToggle.checked;
            if (box) box.style.display = on ? 'block' : 'none';
            await metaSet('log_visible', on);
            if (on) renderLogs();
        });
        const logRefresh = $('pi_log_refresh');
        if (logRefresh) logRefresh.addEventListener('click', renderLogs);
        const logClear = $('pi_log_clear');
        if (logClear) logClear.addEventListener('click', async () => {
            if (!confirm('로그를 전부 삭제할까요? 되돌릴 수 없습니다.')) return;
            try { await dbClear(STORE_LOGS); renderLogs(); toast('로그를 비웠습니다.', 'info'); }
            catch (e) { toast('로그 삭제 실패: ' + e.message, 'error'); }
        });
        const keepSave = $('pi_log_keep_save');
        if (keepSave) keepSave.addEventListener('click', async () => {
            const v = parseInt($('pi_log_keep').value, 10);
            if (isNaN(v) || v < 10) { toast('10 이상 입력하세요.', 'warning'); return; }
            logMaxKeep = v; await metaSet('log_max_keep', v);
            toast('보관 개수를 ' + v + '개로 설정했습니다.', 'success');
        });

        const wlSave = $('pi_wl_save');
        if (wlSave) wlSave.addEventListener('click', async () => {
            try {
                const raw = $('pi_wl_extra') ? $('pi_wl_extra').value : '';
                const list = raw.split('\n').map((s) => s.trim()).filter(Boolean);
                await metaSet('reasoning_whitelist_extra', list);
                toast('수동 목록을 저장했습니다.', 'success');
                await updateActiveInfo();
            } catch (e) { toast('저장 실패: ' + e.message, 'error'); }
        });

        const wlFetch = $('pi_wl_fetch');
        if (wlFetch) wlFetch.addEventListener('click', async () => {
            const status = $('pi_wl_status');
            const setStatus = (t) => { if (status) status.textContent = t; };
            wlFetch.disabled = true;
            setStatus('GitHub에서 받아오는 중…');
            try {
                const { models, verbosityRe } = await fetchWhitelistFromGitHub();
                await metaSet('reasoning_whitelist_fetched', models);
                if (verbosityRe) await metaSet('verbosity_regex_fetched', verbosityRe);
                await metaSet('whitelist_fetched_at', Date.now());
                setStatus(`갱신 완료 · reasoning ${models.length}개`
                    + (verbosityRe ? ` · verbosity /${verbosityRe}/` : '')
                    + ` · ${new Date().toLocaleString()}`);
                toast('화이트리스트를 갱신했습니다.', 'success');
                await updateActiveInfo();
            } catch (e) {
                setStatus('갱신 실패: ' + (e && e.message ? e.message : String(e)) + ' (내장 목록 유지)');
                toast('자동 갱신 실패 — 내장 목록을 그대로 사용합니다.', 'warning');
            } finally {
                wlFetch.disabled = false;
            }
        });
    }

    function bindStEvents(ctx) {
        try {
            const ev = ctx.eventTypes;
            const on = (name) => {
                if (ev[name]) ctx.eventSource.on(ev[name], () => { try { updateActiveInfo(); } catch (e) {} });
            };
            on('CHATCOMPLETION_MODEL_CHANGED');
            on('CONNECTION_PROFILE_LOADED');
            on('ONLINE_STATUS_CHANGED');
            on('MAIN_API_CHANGED');
        } catch (e) { console.warn(LOG_PREFIX, 'ST 이벤트 바인딩 오류:', e); }
    }

    // ── 초기화 ──────────────────────────────────────────────────────────
    async function injectPanel() {
        try {
            const host = document.getElementById('extensions_settings2')
                || document.getElementById('extensions_settings');
            if (!host) { console.warn(LOG_PREFIX, '확장 설정 영역을 찾지 못했습니다.'); return; }
            if (document.getElementById('pi_drawer')) return;

            const drawer = document.createElement('div');
            drawer.id = 'pi_drawer';
            drawer.className = 'inline-drawer';
            drawer.innerHTML = `
<div class="inline-drawer-toggle inline-drawer-header">
  <b>Reasoning Param Injector</b>
  <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
</div>
<div class="inline-drawer-content" id="pi_drawer_content"></div>`;
            host.appendChild(drawer);

            drawer.querySelector('#pi_drawer_content').innerHTML = await buildPanelHTML();

            bindEvents();
            bindHelpToggle();
            await updateActiveInfo();
            if (await metaGet('log_visible', false)) renderLogs();
        } catch (e) { console.warn(LOG_PREFIX, '패널 주입 오류:', e); }
    }

    async function init() {
        try {
            logMaxKeep = await metaGet('log_max_keep', 200);
            const ctx = getCtx();
            if (!ctx || !ctx.eventSource || !ctx.eventTypes) {
                console.warn(LOG_PREFIX, 'ST 컨텍스트/이벤트를 찾지 못했습니다. 주입 비활성.');
            } else {
                const evt = ctx.eventTypes.CHAT_COMPLETION_SETTINGS_READY;
                if (evt) {
                    ctx.eventSource.on(evt, onSettingsReady);
                    console.log(LOG_PREFIX, 'CHAT_COMPLETION_SETTINGS_READY 핸들러 등록 완료.');
                } else {
                    console.warn(LOG_PREFIX, 'CHAT_COMPLETION_SETTINGS_READY 이벤트 없음(ST 버전 확인).');
                }
                bindStEvents(ctx);
            }
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => setTimeout(injectPanel, 800));
            } else {
                setTimeout(injectPanel, 800);
            }
        } catch (e) { console.warn(LOG_PREFIX, 'init 오류:', e); }
    }

    if (typeof jQuery !== 'undefined') { jQuery(() => init()); }
    else { init(); }
})();
