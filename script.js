const DEBUG = false;
const NS = "http://www.w3.org/2000/svg";

const MOVE_COST = 3;
const PLATFORM_COST = 5;
const TRANSFER_COST = 7;

const ROUTE_WIDTH = 7;
const TRANSFER_WIDTH = 15;
const TERMINAL_WIDTH = 13;
const DIM_STRENGTH = 0.2;

const LIVE_TRANSFORM = true;
const COMMIT_DELAY = 150;
const ZOOM_STEP = 0.85;
const DRAG_THRESHOLD = 5;

const city = location.pathname.split("/").filter(Boolean)[0];
const [stations, lines, mapText] = await Promise.all([
    fetch(`/${city}/stations.json`).then((r) => r.json()),
    fetch(`/${city}/lines.json`).then((r) => r.json()),
    fetch(`/${city}/map.svg`).then((r) => (r.ok ? r.text() : null)).catch(() => null),
]);

const $ = (id) => document.getElementById(id);
const result = $("result");
const departureInput = $("departure");
const destinationInput = $("destination");
const suggest = $("suggest");
const panel = $("panel");
const handle = $("handle");
const searchBox = $("search");
const panelBody = panel.querySelector(":scope > .panel-body") ?? wrapPanelBody();

const mobile = matchMedia("(max-width: 768px)");
const coarsePointer = matchMedia("(pointer: coarse)");
const SHEETS = ["peek", "half", "full"];
let sheet = "peek";

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

function svgEl(tag, attrs = {}) {
    const el = document.createElementNS(NS, tag);
    for (const key in attrs) el.setAttribute(key, attrs[key]);
    return el;
}

function wrapPanelBody() {
    const body = document.createElement("div");
    body.className = "panel-body";
    body.append(...[...panel.childNodes].filter((node) => !node.contains(handle)));
    panel.append(body);
    return body;
}

const hasOneway = (line, service) => lines[line].oneway?.[service] !== undefined;
const stateKey = (station, line, service, i) =>
    hasOneway(line, service) ? `${station}|${line}|${service}|${i}` : `${station}|${line}|${service}`;

const occurrences = new Map();
for (const [line, { services }] of Object.entries(lines)) {
    for (const [service, stops] of Object.entries(services)) {
        stops.forEach((station, i) => {
            let list = occurrences.get(station);
            if (!list) occurrences.set(station, (list = []));
            list.push({ line, service, i, key: stateKey(station, line, service, i) });
        });
    }
}

function segmentCost(line, service, prev, next) {
    const { loop, distances, velocities, dwells } = lines[line];
    const raw = distances?.[next] - distances?.[prev];
    const distance = loop && raw < 0 ? loop + raw : raw;

    if (Number.isNaN(distance) || distance <= 0) {
        if (DEBUG) console.warn(`${Number.isNaN(distance) ? "거리 정보 없음" : "거리가 음수임"}: ${line} ${service} ${prev} → ${next}`);
        return MOVE_COST;
    }
    return distance / (velocities?.[service] ?? 1) + (dwells?.[service] ?? 1);
}

function blockedBackward(line, service, i) {
    return (lines[line].oneway?.[service] ?? []).some(([a, b]) => a <= i - 1 && i <= b);
}

const neighborCache = new Map();
function getNeighbors(key) {
    const cached = neighborCache.get(key);
    if (cached) return cached;

    const [station, line, service, at] = key.split("|");
    const stops = lines[line].services[service];
    const here = occurrences.get(station) ?? [];
    const neighbors = new Map();

    for (const o of here) {
        if (o.key !== key) neighbors.set(o.key, o.line === line ? PLATFORM_COST : TRANSFER_COST);
    }

    const indexes = at === undefined
        ? here.filter((o) => o.line === line && o.service === service).map((o) => o.i)
        : [Number(at)];
    for (const i of indexes) {
        if (i > 0 && !blockedBackward(line, service, i)) {
            neighbors.set(stateKey(stops[i - 1], line, service, i - 1), segmentCost(line, service, stops[i - 1], station));
        }
        if (i < stops.length - 1) {
            neighbors.set(stateKey(stops[i + 1], line, service, i + 1), segmentCost(line, service, station, stops[i + 1]));
        }
    }

    const list = [...neighbors];
    neighborCache.set(key, list);
    return list;
}

const heapLess = (x, y) => x[0] < y[0] || (x[0] === y[0] && x[1] < y[1]);
class MinHeap {
    #a = [];
    get size() { return this.#a.length; }
    push(item) {
        const a = this.#a;
        let i = a.length;
        a.push(item);
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (!heapLess(item, a[p])) break;
            a[i] = a[p];
            i = p;
        }
        a[i] = item;
    }
    pop() {
        const a = this.#a;
        const top = a[0];
        const last = a.pop();
        const n = a.length;
        if (n > 0) {
            let i = 0;
            for (;;) {
                let m = 2 * i + 1;
                if (m >= n) break;
                if (m + 1 < n && heapLess(a[m + 1], a[m])) m++;
                if (!heapLess(a[m], last)) break;
                a[i] = a[m];
                i = m;
            }
            a[i] = last;
        }
        return top;
    }
}

function getRoute(from, to) {
    const dist = new Map();
    const prev = new Map();
    const heap = new MinHeap();
    const target = `${to}|`;
    let seq = 0;

    for (const { key } of occurrences.get(from) ?? []) {
        if (dist.has(key)) continue;
        dist.set(key, 0);
        prev.set(key, null);
        heap.push([0, seq++, key]);
    }

    while (heap.size > 0) {
        const [d, , cur] = heap.pop();
        if (d > dist.get(cur)) continue;
        if (cur.startsWith(target)) return [cur, prev, d];

        for (const [next, cost] of getNeighbors(cur)) {
            const nd = d + cost;
            const old = dist.get(next);
            if (old === undefined || nd < old) {
                dist.set(next, nd);
                prev.set(next, cur);
                heap.push([nd, seq++, next]);
            }
        }
    }
}

function stationLabel(id) {
    const { st, en } = stations[id] ?? {};
    return [st, en].filter(Boolean).join(" ") || id;
}

function formatDuration(minutes) {
    return `Total: ${Math.floor(minutes / 60)}h ${Math.floor(minutes % 60)}m ${Math.floor(minutes * 60 % 60)}s`;
}

function lineDiagram(lineData, service, count) {
    const color = lineData.color;
    const h = 32 * count;
    const svg = svgEl("svg", { width: "2rem", height: `${2 * count}rem`, viewBox: `0 0 32 ${h}` });
    svg.append(svgEl("path", { d: `M16 16V${h - 16}`, fill: "none", stroke: color, "stroke-width": 8 }));

    const subcolor = lineData.subcolor?.[service];
    if (subcolor !== undefined) {
        svg.append(svgEl("path", {
            d: `M8 24V${h - 24}`, fill: "none", stroke: subcolor, "stroke-width": 2, "stroke-linecap": "round",
        }));
    }
    for (let j = 0; j < count; j++) {
        const cy = 32 * j + 16;
        svg.append(svgEl("circle", j === 0 || j === count - 1
            ? { cx: 16, cy, r: 6, fill: "white", stroke: color, "stroke-width": 4 }
            : { cx: 20, cy, r: 4, fill: "white" }));
    }
    return svg;
}

function lineHeader(line) {
    const lineData = lines[line];
    const icon = document.createElement("div");
    const [iconClass, iconMode, iconText = ""] = lineData.icon ?? [];
    if (iconClass) icon.classList.add(iconClass);
    if (iconMode === "background") icon.style.backgroundColor = lineData.color;
    if (iconMode === "outline" || iconMode === "text") icon.style.outlineColor = lineData.color;
    if (iconMode === "text") icon.style.color = lineData.color;
    icon.append(iconText);

    const row = document.createElement("div");
    row.className = "line-row";
    row.append(icon, `${lineData.st ?? line} ${lineData.en ?? ""}`.trim());
    return row;
}

function buildPath(path, dist) {
    const list = document.createElement("div");
    list.append(formatDuration(dist));

    for (let i = 0; i < path.length; i++) {
        const stationList = document.createElement("div");
        for (; i < path.length; i++) {
            const row = document.createElement("span");
            row.className = "station-row";
            row.textContent = stationLabel(path[i][0]);
            stationList.append(row);
            if (i === path.length - 1 || path[i][0] === path[i + 1][0]) break;
        }

        const [, line, service] = path[i];
        const box = document.createElement("div");
        box.className = "line-box";
        box.append(lineDiagram(lines[line], service, stationList.childElementCount), stationList);
        list.append(lineHeader(line), box);
    }
    return list;
}

let suggestInput = null;
let suggestIndex = -1;

const searchables = setupSearch();
closeSuggest();
setSheet("peek");
if (DEBUG) checkMissingStations();

function setupSearch() {
    for (const input of [departureInput, destinationInput]) {
        input.autocomplete = "off";
        input.addEventListener("input", () => {
            input.dataset.id = "";
            openSuggest(input);
        });
        input.addEventListener("focus", () => {
            if (mobile.matches) setSheet("full");
            openSuggest(input);
        });
        input.addEventListener("blur", () => setTimeout(() => {
            if (suggestInput === input && document.activeElement !== input) closeSuggest();
        }, 200));
        input.addEventListener("keydown", (e) => {
            if (suggestInput !== input) return;
            switch (e.key) {
                case "ArrowDown": moveSuggest(1); break;
                case "ArrowUp": moveSuggest(-1); break;
                case "Escape": closeSuggest(); break;
                case "Enter":
                    if (suggestIndex < 0) return;
                    chooseSuggest(input, suggest.querySelectorAll("li[data-id]")[suggestIndex].dataset.id);
                    break;
                default: return;
            }
            e.preventDefault();
        });
    }

    suggest.addEventListener("click", (e) => {
        const li = e.target.closest("li[data-id]");
        if (li && suggestInput) chooseSuggest(suggestInput, li.dataset.id);
    });

    const list = [];
    for (const id of Object.keys(stations)) {
        if (!occurrences.has(id)) continue;
        const { st, en } = stations[id];
        const keys = (st || en ? [st, en] : [id]).filter(Boolean).map((k) => String(k).toLowerCase());
        list.push({ id, label: stationLabel(id), keys });
    }
    return list;
}

function checkMissingStations() {
    const missing = new Map();
    for (const [lineId, { services }] of Object.entries(lines)) {
        for (const [serviceId, stops] of Object.entries(services)) {
            for (const id of stops) {
                if (Object.hasOwn(stations, id)) continue;
                if (!missing.has(id)) missing.set(id, new Set());
                missing.get(id).add(`${lineId}.${serviceId}`);
            }
        }
    }
    for (const [id, where] of missing) console.warn(`역 정보 없음: ${id} (${[...where].join(", ")})`);
}

function setStation(input, id) {
    input.value = id ? stationLabel(id) : "";
    input.dataset.id = id ?? "";
}

function closeSuggest() {
    suggest.replaceChildren();
    suggest.hidden = true;
    suggestInput = null;
    suggestIndex = -1;
}

function chooseSuggest(input, id) {
    setStation(input, id);
    closeSuggest();
    markStation(input === departureInput ? "departure" : "destination", id);
}

function openSuggest(input) {
    const query = input.value.trim().toLowerCase();
    if (!query) return closeSuggest();

    const starts = [], contains = [];
    for (const item of searchables) {
        if (item.keys.some((key) => key.startsWith(query))) starts.push(item);
        else if (item.keys.some((key) => key.includes(query))) contains.push(item);
    }

    const items = [...starts, ...contains].map(({ id, label }) => {
        const li = document.createElement("li");
        li.textContent = label;
        li.dataset.id = id;
        return li;
    });
    if (items.length === 0) {
        const li = document.createElement("li");
        li.className = "empty";
        li.textContent = "No results";
        items.push(li);
    }
    suggest.replaceChildren(...items);

    suggestInput = input;
    suggestIndex = -1;
    Object.assign(suggest.style, {
        top: `${input.offsetTop + input.offsetHeight}px`,
        left: `${input.offsetLeft}px`,
        width: `${input.offsetWidth}px`,
    });
    suggest.hidden = false;
}

function moveSuggest(step) {
    const items = suggest.querySelectorAll("li[data-id]");
    if (items.length === 0) return;
    items[suggestIndex]?.classList.remove("active");
    suggestIndex = (suggestIndex + step + items.length) % items.length;
    items[suggestIndex].classList.add("active");
    items[suggestIndex].scrollIntoView({ block: "nearest" });
}

function showRoute(departure, destination) {
    setStation(departureInput, departure);
    setStation(destinationInput, destination);
    markStation("departure", departure);
    markStation("destination", destination);

    const route = getRoute(departure, destination);
    if (route === undefined) {
        result.replaceChildren("No route found");
        highlightRoute(null);
        return;
    }

    const [goal, prev, dist] = route;
    const path = [];
    for (let cur = goal; cur !== null; cur = prev.get(cur)) path.push(cur.split("|"));
    path.reverse();

    result.replaceChildren(buildPath(path, dist));
    highlightRoute(path);
}

function offsetWithin(el, ancestor) {
    let y = 0;
    for (let node = el; node && node !== ancestor; node = node.offsetParent) y += node.offsetTop;
    return y;
}

function sheetOffsets() {
    const height = panel.offsetHeight;
    const peek = Math.max(0, height - (offsetWithin(searchBox, panel) + searchBox.offsetHeight + 16));
    const half = Math.min(peek, Math.max(0, height - innerHeight * 0.5));
    return { peek, half, full: 0 };
}

function setSheet(state = sheet) {
    sheet = state;
    panel.classList.toggle("full", sheet === "full");
    panel.style.transform = mobile.matches ? `translateY(${sheetOffsets()[sheet]}px)` : "";
    if (mobile.matches && sheet !== "full") panelBody.scrollTop = 0;
}

let highlightRoute = () => {};
let markStation = () => {};

if (mapText !== null) setupMap(new DOMParser().parseFromString(mapText, "image/svg+xml").documentElement);
else $("map").hidden = true;

function setupMap(svg) {
    const mapEl = $("map");
    const [mapX, mapY, mapW, mapH] = svg.getAttribute("viewBox").split(/[\s,]+/).map(Number);
    mapEl.append(svg);
    if (getComputedStyle(mapEl).overflow === "visible") mapEl.style.overflow = "hidden";
    svg.style.transformOrigin = "0 0";

    const layer = (id) => {
        let g = svg.querySelector(`:scope > #${id}`);
        if (!g) svg.append((g = svgEl("g")));
        return g;
    };
    const lineLayer = layer("line"), legend = layer("legend"), textLayer = layer("text"), etc = layer("etc");
    const defs = svgEl("defs");
    const routed = svgEl("g");
    const bridges = svgEl("g");
    const boxLayer = svgEl("g");
    const markLayer = svgEl("g");

    lineLayer.before(routed);
    bridges.append(...etc.querySelectorAll(":scope > path, :scope > line"));
    boxLayer.append(...etc.querySelectorAll(":scope > rect"));
    routed.append(lineLayer, layer("transfer"), layer("station"), bridges);
    legend.before(boxLayer);
    svg.append(defs, markLayer);

    const labels = [...textLayer.querySelectorAll(":scope > g")].map((element) => {
        const { x, y, width, height } = element.getBBox();
        return { element, x: x + width / 2, y: y + height / 2, dimmed: false };
    });

    const platformsOf = new Map();
    const platforms = [];
    for (const lineData of Object.values(lines)) {
        for (const positions of [lineData.positions ?? {}, ...Object.values(lineData.servicePositions ?? {})]) {
            for (const [id, [x, y]] of Object.entries(positions)) {
                platforms.push([x, y, id]);
                if (!platformsOf.has(id)) platformsOf.set(id, []);
                platformsOf.get(id).push([x, y]);
            }
        }
    }

    const CELL = 32;
    const cellKey = (cx, cy) => cx * 0x10000 + cy;
    const grid = new Map();
    for (const p of platforms) {
        const key = cellKey(Math.floor(p[0] / CELL), Math.floor(p[1] / CELL));
        let bucket = grid.get(key);
        if (!bucket) grid.set(key, (bucket = []));
        bucket.push(p);
    }

    function pathOf(points) {
        const pts = points.filter((p, i) => i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1]);
        const m = pts.length;
        if (m === 1) return `M${pts[0][0]} ${pts[0][1]}L${pts[0][0]} ${pts[0][1]}`;

        const cut = new Array(m).fill(0);
        const turn = new Array(m).fill(0);
        for (let i = 1; i < m - 1; i++) {
            const radius = pts[i][2];
            if (!radius) continue;
            const a1 = Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]);
            const a2 = Math.atan2(pts[i + 1][1] - pts[i][1], pts[i + 1][0] - pts[i][0]);
            const d = Math.atan2(Math.sin(a2 - a1), Math.cos(a2 - a1));
            if (Math.abs(d) < 1e-6) continue;
            turn[i] = d;
            cut[i] = radius * Math.tan(Math.abs(d) / 2);
        }
        for (let i = 0; i < m - 1; i++) {
            const length = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
            const need = cut[i] + cut[i + 1];
            if (need > length) {
                cut[i] *= length / need;
                cut[i + 1] *= length / need;
            }
        }

        const f = (v) => +v.toFixed(2);
        let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
        for (let i = 1; i < m; i++) {
            const [x, y] = pts[i];
            if (cut[i] === 0) {
                d += `L${f(x)} ${f(y)}`;
                continue;
            }
            const [px, py] = pts[i - 1], [nx, ny] = pts[i + 1];
            const l1 = Math.hypot(x - px, y - py), l2 = Math.hypot(nx - x, ny - y);
            const r = cut[i] / Math.tan(Math.abs(turn[i]) / 2);
            d += `L${f(x - (x - px) / l1 * cut[i])} ${f(y - (y - py) / l1 * cut[i])}`;
            d += `A${f(r)} ${f(r)} 0 0 ${turn[i] > 0 ? 1 : 0} ${f(x + (nx - x) / l2 * cut[i])} ${f(y + (ny - y) / l2 * cut[i])}`;
        }
        return d;
    }

    const shapeCache = new Map();
    function stationShape(id) {
        let d = shapeCache.get(id);
        if (d !== undefined) return d;
        const points = platformsOf.get(id);
        const joined = [points[0]], rest = points.slice(1);
        d = pathOf([points[0], points[0]]);
        while (rest.length > 0) {
            let best = null;
            for (const p of joined) {
                for (const q of rest) {
                    const distance = Math.hypot(p[0] - q[0], p[1] - q[1]);
                    if (best === null || distance < best[0]) best = [distance, p, q];
                }
            }
            d += pathOf([best[1], best[2]]);
            joined.push(best[2]);
            rest.splice(rest.indexOf(best[2]), 1);
        }
        shapeCache.set(id, d);
        return d;
    }

    const view = { x: mapX, y: mapY, w: mapW };
    let shown = { ...view };
    let shift = null;
    let size = { w: 0, h: 0 };
    let origin = { left: 0, top: 0 };
    let originDirty = true;
    let frame = 0, commitTimer = 0, viewBoxText = "";

    function measure() {
        const rect = svg.getBoundingClientRect();
        origin = {
            left: rect.left - (shift?.x ?? 0) + svg.clientLeft,
            top: rect.top - (shift?.y ?? 0) + svg.clientTop,
        };
        size = { w: svg.clientWidth, h: svg.clientHeight };
        originDirty = false;
    }
    const markDirty = () => { originDirty = true; };
    addEventListener("scroll", markDirty, { passive: true, capture: true });
    addEventListener("resize", markDirty, { passive: true });

    function commit() {
        clearTimeout(commitTimer);
        cancelAnimationFrame(frame);
        commitTimer = frame = 0;
        if (size.w === 0 || size.h === 0) return;
        const text = `${view.x} ${view.y} ${view.w} ${view.w * size.h / size.w}`;
        if (text !== viewBoxText) svg.setAttribute("viewBox", (viewBoxText = text));
        shown = { ...view };
        if (shift) {
            shift = null;
            svg.style.transform = svg.style.willChange = "";
        }
    }

    function renderLive() {
        frame = 0;
        const s = size.w / view.w;
        shift = { x: (shown.x - view.x) * s, y: (shown.y - view.y) * s };
        svg.style.willChange = "transform";
        svg.style.transform = `translate(${shift.x}px, ${shift.y}px) scale(${shown.w / view.w})`;
    }

    function moveView() {
        if (!LIVE_TRANSFORM) {
            if (!frame) frame = requestAnimationFrame(() => { frame = 0; commit(); });
            return;
        }
        if (!frame) frame = requestAnimationFrame(renderLive);
        clearTimeout(commitTimer);
        commitTimer = setTimeout(commit, COMMIT_DELAY);
    }

    measure();
    const ratio = size.w / size.h || mapW / mapH;
    view.w = Math.max(mapW, mapH * ratio);
    view.x = mapX + (mapW - view.w) / 2;
    view.y = mapY + (mapH - view.w / ratio) / 2;
    if (mobile.matches && size.w) view.y += (innerHeight - panel.getBoundingClientRect().top) / 2 * view.w / size.w;
    commit();
    new ResizeObserver(() => { measure(); commit(); }).observe(svg);

    function toMapPoint({ clientX, clientY }) {
        if (originDirty) measure();
        const s = view.w / size.w;
        return { x: view.x + (clientX - origin.left) * s, y: view.y + (clientY - origin.top) * s };
    }

    const clampW = (w) => clamp(w, mapW / 24, mapW * 2);

    function zoomAt(p, factor) {
        const w = clampW(view.w * factor);
        const r = w / view.w;
        view.x = p.x - (p.x - view.x) * r;
        view.y = p.y - (p.y - view.y) * r;
        view.w = w;
        moveView();
    }

    svg.addEventListener("wheel", (e) => {
        e.preventDefault();
        if (e.deltaY === 0) return;
        let delta = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 100 : 1);
        if (e.ctrlKey) delta *= 4;
        zoomAt(toMapPoint(e), ZOOM_STEP ** (-clamp(delta, -300, 300) / 100));
    }, { passive: false });

    const pointers = new Map();
    let drag = null, pinch = null;
    const midpoint = () => {
        const [a, b] = pointers.values();
        return { clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2, dist: Math.hypot(a.x - b.x, a.y - b.y) };
    };

    svg.addEventListener("pointerdown", (e) => {
        svg.setPointerCapture(e.pointerId);
        originDirty = true;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 1) {
            drag = { start: toMapPoint(e), x: e.clientX, y: e.clientY, moved: false };
        } else if (pointers.size === 2) {
            const m = midpoint();
            pinch = { dist: m.dist, w: view.w, anchor: toMapPoint(m) };
            if (drag) drag.moved = true;
        }
    });

    let hoverPoint = null, hoverFrame = 0, hoverCursor = "";
    function updateHover() {
        hoverFrame = 0;
        const cursor = nearestStation(toMapPoint(hoverPoint)) !== null ? "pointer" : "";
        if (cursor !== hoverCursor) svg.style.cursor = hoverCursor = cursor;
    }

    svg.addEventListener("pointermove", (e) => {
        if (!pointers.has(e.pointerId)) {
            if (e.pointerType === "touch") return;
            hoverPoint = { clientX: e.clientX, clientY: e.clientY };
            if (!hoverFrame) hoverFrame = requestAnimationFrame(updateHover);
            return;
        }
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (pinch && pointers.size >= 2) {
            const m = midpoint();
            view.w = clampW(pinch.w * pinch.dist / Math.max(1, m.dist));
            const now = toMapPoint(m);
            view.x += pinch.anchor.x - now.x;
            view.y += pinch.anchor.y - now.y;
            moveView();
            return;
        }
        if (!drag) return;
        if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) drag.moved = true;
        if (!drag.moved) return;
        const p = toMapPoint(e);
        view.x -= p.x - drag.start.x;
        view.y -= p.y - drag.start.y;
        moveView();
    });

    const release = (e) => {
        if (!pointers.delete(e.pointerId)) return;
        if (pointers.size < 2) pinch = null;
        if (pointers.size === 1) {
            const [p] = pointers.values();
            drag = { start: toMapPoint({ clientX: p.x, clientY: p.y }), x: p.x, y: p.y, moved: true };
        } else if (pointers.size === 0) {
            commit();
        }
    };
    svg.addEventListener("pointerup", release);
    svg.addEventListener("pointercancel", release);

    function nearestStation({ x, y }) {
        const reach = (coarsePointer.matches ? 22 : 12) * view.w / size.w;
        const limit = Math.max(8, reach);
        let best = null, bestSq = limit * limit;
        const test = ([px, py, id]) => {
            const d = (px - x) ** 2 + (py - y) ** 2;
            if (d < bestSq) { best = id; bestSq = d; }
        };

        const x0 = Math.floor((x - limit) / CELL), x1 = Math.floor((x + limit) / CELL);
        const y0 = Math.floor((y - limit) / CELL), y1 = Math.floor((y + limit) / CELL);
        if ((x1 - x0 + 1) * (y1 - y0 + 1) > grid.size) {
            platforms.forEach(test);
        } else {
            for (let cx = x0; cx <= x1; cx++) {
                for (let cy = y0; cy <= y1; cy++) grid.get(cellKey(cx, cy))?.forEach(test);
            }
        }
        return best;
    }

    let picking = "departure";
    svg.addEventListener("click", (e) => {
        if (drag?.moved) return;
        const id = nearestStation(toMapPoint(e));

        if (id === null) {
            if (!fogShown) return;
            highlightRoute(null);
            markStation("departure", null);
            markStation("destination", null);
            setStation(departureInput, null);
            setStation(destinationInput, null);
            result.replaceChildren();
            picking = "departure";
            return;
        }

        if (picking === "departure") {
            setStation(departureInput, id);
            setStation(destinationInput, null);
            highlightRoute(null);
            markStation("departure", id);
            markStation("destination", null);
            picking = "destination";
        } else {
            setStation(destinationInput, id);
            showRoute(departureInput.dataset.id, id);
            picking = "departure";
        }
    });

    const marks = {};
    markStation = (kind, id) => {
        marks[kind]?.remove();
        marks[kind] = null;
        if (!platformsOf.has(id)) return;
        const mark = svgEl("path", { d: stationShape(id), class: `station-mark ${kind}` });
        markLayer.append(mark);
        marks[kind] = mark;
    };

    const makeStroke = (d, color, width) => svgEl("path", {
        d, fill: "none", stroke: color, "stroke-width": width, "stroke-linecap": "round", "stroke-linejoin": "round",
    });
    const makeCover = (el) => {
        const cover = el.cloneNode(false);
        cover.removeAttribute("class");
        for (const [k, v] of [["fill", "none"], ["stroke", "white"], ["stroke-width", ROUTE_WIDTH]]) cover.setAttribute(k, v);
        return cover;
    };
    const toRgb = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
    const rgbOf = Object.fromEntries(Object.entries(lines).map(([line, { color }]) => [line, toRgb(color)]));

    const strokeBodies = (elements) => [...elements].flatMap((el) => {
        const s = getComputedStyle(el);
        return s.stroke !== "none" && s.stroke !== "rgb(255, 255, 255)" && s.strokeDasharray === "none"
            ? [{ el, stroke: s.stroke, width: parseFloat(s.strokeWidth) || 1 }]
            : [];
    });

    function bounds(el, pad, local = false) {
        const b = el.getBBox();
        let box = [b.x, b.y, b.x + b.width, b.y + b.height];
        const list = el.transform?.baseVal;
        if (!local && list?.numberOfItems) {
            let m = new DOMMatrix();
            for (let i = 0; i < list.numberOfItems; i++) m = m.multiply(list.getItem(i).matrix);
            const pts = [[box[0], box[1]], [box[2], box[1]], [box[0], box[3]], [box[2], box[3]]]
                .map(([x, y]) => m.transformPoint({ x, y }));
            const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
            box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
        }
        return [box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad];
    }
    function pointsBox(points, pad) {
        let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
        for (const [x, y] of points) {
            if (x < x1) x1 = x;
            if (y < y1) y1 = y;
            if (x > x2) x2 = x;
            if (y > y2) y2 = y;
        }
        return [x1 - pad, y1 - pad, x2 + pad, y2 + pad];
    }
    const overlaps = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
    const inBox = (b, x, y) => b[0] <= x && x <= b[2] && b[1] <= y && y <= b[3];

    const COVER_PAD = ROUTE_WIDTH * 2 + 1;

    const lineGroups = [...lineLayer.children].map((group) => {
        const bodies = strokeBodies(group.querySelectorAll("path, line, circle, polyline"));
        return {
            color: bodies[0]?.stroke,
            bodies: bodies.map(({ el, width }) => ({ el, hit: bounds(el, width / 2 + 1, true) })),
            covers: bodies.map(({ el }) => ({ el: makeCover(el), box: bounds(el, COVER_PAD) })),
        };
    });

    const groupOf = {};
    for (const [line, lineData] of Object.entries(lines)) {
        const points = Object.values(lineData.positions ?? {}).map(([x, y]) => [x, y, new DOMPoint(x, y)]);
        let best = -1, bestCount = -1;
        lineGroups.forEach((group, i) => {
            if (group.color !== rgbOf[line]) return;
            let count = 0;
            for (const [x, y, p] of points) {
                if (group.bodies.some(({ el, hit }) => inBox(hit, x, y) && el.isPointInStroke(p))) count++;
            }
            if (count > bestCount) { best = i; bestCount = count; }
        });
        groupOf[line] = best;
    }

    const bridgeCovers = strokeBodies(bridges.children).map(({ el, stroke }) => {
        const mid = el.getPointAtLength(el.getTotalLength() / 2);
        return { color: stroke, middle: [mid.x, mid.y], cover: makeCover(el), box: bounds(el, COVER_PAD) };
    });

    const terminals = new Set();
    for (const { services, loop } of Object.values(lines)) {
        if (loop) continue;
        const ends = new Set(), middles = new Set();
        for (const stops of Object.values(services)) {
            stops.forEach((station, i) => (i === 0 || i === stops.length - 1 ? ends : middles).add(station));
        }
        for (const station of ends) if (!middles.has(station)) terminals.add(station);
    }

    function edgePoints(line, service, a, b) {
        const lineData = lines[line];
        const position = (id) => lineData.servicePositions?.[service]?.[id] ?? lineData.positions?.[id];
        const pa = position(a), pb = position(b);
        if (!pa || !pb) return [];
        const bends = lineData.bends?.[`${a}|${b}`] ?? [...(lineData.bends?.[`${b}|${a}`] ?? [])].reverse();
        return [pa, ...bends, pb];
    }

    function stopsByIndex(line, service, i, j) {
        const stops = lines[line].services[service];
        return i <= j ? stops.slice(i, j + 1) : stops.slice(j, i + 1).reverse();
    }

    function stopsBetween(line, a, b) {
        let best = [a, b];
        for (const stops of Object.values(lines[line].services)) {
            const as = [], bs = [];
            stops.forEach((s, i) => {
                if (s === a) as.push(i);
                if (s === b) bs.push(i);
            });
            let range = null;
            for (const i of as) {
                for (const j of bs) {
                    if (range === null || Math.abs(i - j) < Math.abs(range[0] - range[1])) range = [i, j];
                }
            }
            if (range === null) continue;
            const [i, j] = range;
            const part = i < j ? stops.slice(i, j + 1) : stops.slice(j, i + 1).reverse();
            if (part.length > best.length) best = part;
        }
        return best;
    }

    function distanceTo(points, [x, y]) {
        let best = Infinity;
        for (let i = 1; i < points.length; i++) {
            const [x1, y1] = points[i - 1], [x2, y2] = points[i];
            const dx = x2 - x1, dy = y2 - y1;
            const t = clamp(((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy || 1), 0, 1);
            best = Math.min(best, Math.hypot(x - x1 - t * dx, y - y1 - t * dy));
        }
        return best;
    }

    const fogMask = svgEl("mask", {
        id: "fog-mask", maskUnits: "userSpaceOnUse", x: mapX, y: mapY, width: mapW, height: mapH,
    });
    const fog = svgEl("rect", {
        x: mapX, y: mapY, width: mapW, height: mapH,
        fill: "white", "fill-opacity": 1 - DIM_STRENGTH, mask: "url(#fog-mask)", "pointer-events": "none",
    });
    const bgFog = svgEl("g", { opacity: 1 - DIM_STRENGTH, "pointer-events": "none" });
    defs.append(fogMask);

    let fogShown = false;
    function showFog() {
        if (fogShown) return;
        fogShown = true;
        routed.after(fog);
        routed.before(bgFog);
    }
    function hideFog() {
        if (!fogShown) return;
        fogShown = false;
        fog.remove();
        bgFog.remove();
        fogMask.replaceChildren();
        bgFog.replaceChildren();
    }

    const clearOpacity = (el) => {
        el.style.removeProperty("opacity");
        if (el.getAttribute("style") === "") el.removeAttribute("style");
    };
    const setLabelDim = (label, dim) => {
        if (label.dimmed === dim) return;
        label.dimmed = dim;
        if (dim) label.element.style.opacity = DIM_STRENGTH;
        else clearOpacity(label.element);
    };

    highlightRoute = (path) => {
        if (path === null) {
            hideFog();
            for (const label of labels) setLabelDim(label, false);
            clearOpacity(legend);
            return;
        }

        const rides = new Map();
        const passed = new Set(path.map(([station]) => station));
        for (let i = 1; i < path.length; i++) {
            const [a, line, service, ai] = path[i - 1];
            const [b, nextLine, nextService, bi] = path[i];
            if (line !== nextLine || service !== nextService || a === b) continue;

            const stops = bi !== undefined ? stopsByIndex(line, service, Number(ai), Number(bi)) : stopsBetween(line, a, b);
            for (const station of stops) passed.add(station);

            const points = [];
            for (let j = 1; j < stops.length; j++) points.push(...edgePoints(line, service, stops[j - 1], stops[j]));
            if (points.length === 0) continue;

            if (!rides.has(line)) rides.set(line, []);
            rides.get(line).push({ points, d: pathOf(points), box: pointsBox(points, ROUTE_WIDTH) });
        }

        const mask = [svgEl("rect", { x: mapX, y: mapY, width: mapW, height: mapH, fill: "white" })];
        const holes = [];
        const holeBoxes = [];
        const hole = (d, width, box) => {
            holes.push(makeStroke(d, "white", width));
            mask.push(makeStroke(d, "black", width));
            if (box) holeBoxes.push(box);
        };
        const cover = (el, box) => {
            if (holeBoxes.some((b) => overlaps(b, box))) mask.push(el);
        };

        const ridesByGroup = new Map();
        for (const [line, list] of rides) {
            const g = groupOf[line];
            if (!ridesByGroup.has(g)) ridesByGroup.set(g, []);
            ridesByGroup.get(g).push(...list);
        }
        lineGroups.forEach((group, i) => {
            for (const c of group.covers) cover(c.el, c.box);
            for (const r of ridesByGroup.get(i) ?? []) hole(r.d, ROUTE_WIDTH, r.box);
        });
        for (const r of ridesByGroup.get(-1) ?? []) hole(r.d, ROUTE_WIDTH, r.box);

        for (const bridge of bridgeCovers) {
            const used = [...rides].some(([line, list]) =>
                rgbOf[line] === bridge.color && list.some(({ points }) => distanceTo(points, bridge.middle) < 3));
            if (!used) cover(bridge.cover, bridge.box);
        }

        for (const station of passed) {
            const count = platformsOf.get(station)?.length ?? 0;
            if (count > 1) hole(stationShape(station), TRANSFER_WIDTH);
            else if (count === 1 && terminals.has(station)) hole(stationShape(station), TERMINAL_WIDTH);
        }

        fogMask.replaceChildren(...mask);
        bgFog.replaceChildren(...holes);
        showFog();

        legend.style.opacity = DIM_STRENGTH;
        const boxes = path.map(([station]) => stations[station]?.box).filter(Boolean);
        for (const label of labels) {
            const lit = boxes.some(([x1, y1, x2, y2]) => x1 <= label.x && label.x <= x2 && y1 <= label.y && label.y <= y2);
            setLabelDim(label, !lit);
        }
    };
}

let panelDrag = null;
let panelFrame = 0;
let panelOffset = 0;

function endPanelDrag() {
    cancelAnimationFrame(panelFrame);
    panelFrame = 0;
    panel.classList.remove("dragging");
}

function activatePanelDrag(e) {
    panelDrag.active = true;
    panel.setPointerCapture(e.pointerId);
    panel.classList.add("dragging");
}

panel.addEventListener("pointerdown", (e) => {
    if (!mobile.matches || panelDrag) return;
    const fromHandle = handle.contains(e.target);
    if (!fromHandle && sheet === "full") return;
    const offsets = sheetOffsets();
    panelDrag = {
        id: e.pointerId, y: e.clientY, offsets, offset: offsets[sheet],
        lastY: e.clientY, lastTime: e.timeStamp, speed: 0, active: false,
    };
    if (fromHandle) activatePanelDrag(e);
});

panel.addEventListener("pointermove", (e) => {
    const g = panelDrag;
    if (!g || e.pointerId !== g.id) return;
    const moved = e.clientY - g.y;
    if (!g.active) {
        if (Math.abs(moved) < DRAG_THRESHOLD) return;
        activatePanelDrag(e);
    }
    panelOffset = clamp(g.offset + moved, 0, g.offsets.peek);
    if (!panelFrame) {
        panelFrame = requestAnimationFrame(() => {
            panelFrame = 0;
            if (panelDrag) panel.style.transform = `translateY(${panelOffset}px)`;
        });
    }
    g.speed = (e.clientY - g.lastY) / Math.max(1, e.timeStamp - g.lastTime);
    g.lastY = e.clientY;
    g.lastTime = e.timeStamp;
});

panel.addEventListener("pointerup", (e) => {
    const g = panelDrag;
    if (!g || e.pointerId !== g.id) return;
    panelDrag = null;
    endPanelDrag();
    if (!g.active) return;

    const moved = e.clientY - g.y;
    let next;
    if (Math.abs(moved) < DRAG_THRESHOLD) {
        next = sheet === "peek" ? "half" : "peek";
    } else if (Math.abs(g.speed) > 0.5) {
        next = SHEETS[clamp(SHEETS.indexOf(sheet) + (g.speed < 0 ? 1 : -1), 0, SHEETS.length - 1)];
    } else {
        const offset = clamp(g.offset + moved, 0, g.offsets.peek);
        next = SHEETS.reduce((a, b) => (Math.abs(g.offsets[b] - offset) < Math.abs(g.offsets[a] - offset) ? b : a));
    }
    setSheet(next);
});

panel.addEventListener("pointercancel", (e) => {
    if (!panelDrag || e.pointerId !== panelDrag.id) return;
    panelDrag = null;
    endPanelDrag();
    setSheet(sheet);
});

mobile.addEventListener("change", () => setSheet("peek"));

$("random").addEventListener("click", () => {
    const pick = () => searchables[Math.floor(Math.random() * searchables.length)].id;
    showRoute(pick(), pick());
    if (mobile.matches) setSheet("half");
});

searchBox.addEventListener("click", () => {
    const departure = departureInput.dataset.id;
    const destination = destinationInput.dataset.id;
    if (!departure || !destination) {
        result.replaceChildren("No route found");
        return;
    }
    showRoute(departure, destination);
    if (mobile.matches) setSheet("half");
});
