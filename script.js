const DEBUG = false;
const NS = "http://www.w3.org/2000/svg";

const MOVE_COST = 3;
const PLATFORM_COST = 5;
const TRANSFER_COST = 7;

const ROUTE_WIDTH = 7;
const TRANSFER_WIDTH = 15;
const TERMINAL_WIDTH = 13;
const DIM_STRENGTH = 0.2;
const COVER_PAD = ROUTE_WIDTH * 2 + 1;
const STROKE_STYLE = { fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" };
const COVER_STYLE = { fill: "none", stroke: "white", "stroke-width": ROUTE_WIDTH };

const LIVE_TRANSFORM = true;
const COMMIT_DELAY = 150;
const ZOOM_STEP = 0.85;
const DRAG_THRESHOLD = 5;
const CELL = 32;

const city = location.pathname.split("/").filter(Boolean)[0];
const [stations, lines, mapText] = await Promise.all([
    fetch(`/${city}/stations.json`).then((r) => r.json()),
    fetch(`/${city}/lines.json`).then((r) => r.json()),
    fetch(`/${city}/map.svg`).then((r) => (r.ok ? r.text() : null)).catch(() => null),
]);

const result = document.getElementById("result");
const departureInput = document.getElementById("departure");
const destinationInput = document.getElementById("destination");
const suggest = document.getElementById("suggest");
const panel = document.getElementById("panel");
const handle = document.getElementById("handle");
const searchBox = document.getElementById("search");
const mapEl = document.getElementById("map");

let panelBody = panel.querySelector(":scope > .panel-body");
if (!panelBody) {
    panelBody = document.createElement("div");
    panelBody.className = "panel-body";
    panelBody.append(...[...panel.childNodes].filter((node) => !node.contains(handle)));
    panel.append(panelBody);
}

const mobile = matchMedia("(max-width: 768px)");
const coarsePointer = matchMedia("(pointer: coarse)");
const SHEETS = ["peek", "half", "full"];
let sheet = "peek";

const occurrences = new Map();
for (const [line, { services, oneway }] of Object.entries(lines)) {
    for (const [service, stops] of Object.entries(services)) {
        const indexed = oneway?.[service] !== undefined;
        stops.forEach((station, i) => {
            let list = occurrences.get(station);
            if (!list) occurrences.set(station, (list = []));
            list.push({ line, service, i, key: `${station}|${line}|${service}${indexed ? `|${i}` : ""}` });
        });
    }
}
const neighborCache = new Map();

let suggestInput = null;
let suggestIndex = -1;

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
    input.addEventListener("blur", () => setTimeout(closeSuggestOnBlur, 200, input));
    input.addEventListener("keydown", (e) => {
        if (suggestInput !== input) return;
        switch (e.key) {
            case "ArrowDown":
            case "ArrowUp": {
                const items = suggest.querySelectorAll("li[data-id]");
                if (items.length === 0) break;
                items[suggestIndex]?.classList.remove("active");
                suggestIndex = (suggestIndex + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
                items[suggestIndex].classList.add("active");
                items[suggestIndex].scrollIntoView({ block: "nearest" });
                break;
            }
            case "Escape":
                closeSuggest();
                break;
            case "Enter": {
                if (suggestIndex < 0) return;
                const id = suggest.querySelectorAll("li[data-id]")[suggestIndex].dataset.id;
                setStation(input, id);
                closeSuggest();
                markStation(input === departureInput ? "departure" : "destination", id);
                break;
            }
            default:
                return;
        }
        e.preventDefault();
    });
}

suggest.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-id]");
    const input = suggestInput;
    if (!li || !input) return;
    setStation(input, li.dataset.id);
    closeSuggest();
    markStation(input === departureInput ? "departure" : "destination", li.dataset.id);
});

const searchables = [];
for (const id of Object.keys(stations)) {
    if (!occurrences.has(id)) continue;
    const { st, en } = stations[id];
    const keys = (st || en ? [st, en] : [id]).filter(Boolean).map((k) => String(k).toLowerCase());
    searchables.push({ id, label: [st, en].filter(Boolean).join(" ") || id, keys });
}

closeSuggest();
setSheet("peek");

const svg = mapText === null ? null : new DOMParser().parseFromString(mapText, "image/svg+xml").documentElement;
let mapX = 0, mapY = 0, mapW = 0, mapH = 0;
let legend = null, routed = null, markLayer = null;
let fogMask = null, fog = null, bgFog = null, fogShown = false;

const labels = [];
const platforms = [];
const platformsOf = new Map();
const grid = new Map();
const shapeCache = new Map();
const lineGroups = [];
const groupOf = {};
const bridgeCovers = [];
const terminals = new Set();
const rgbOf = {};
const marks = {};

const view = { x: 0, y: 0, w: 0 };
let shown = { ...view };
let shift = null;
let size = { w: 0, h: 0 };
let origin = { left: 0, top: 0 };
let originDirty = true;
let frame = 0, commitTimer = 0, viewBoxText = "";

const pointers = new Map();
let drag = null, pinch = null;
let hoverPoint = null, hoverFrame = 0, hoverCursor = "";
let picking = "departure";

if (svg === null) mapEl.hidden = true;
else {
    [mapX, mapY, mapW, mapH] = svg.getAttribute("viewBox").split(/[\s,]+/).map(Number);
    mapEl.append(svg);
    if (getComputedStyle(mapEl).overflow === "visible") mapEl.style.overflow = "hidden";
    svg.style.transformOrigin = "0 0";

    const lineLayer = mapLayer("line");
    legend = mapLayer("legend");
    const textLayer = mapLayer("text");
    const etc = mapLayer("etc");
    const defs = svgEl("defs");
    const bridges = svgEl("g");
    const boxLayer = svgEl("g");
    routed = svgEl("g");
    markLayer = svgEl("g");

    lineLayer.before(routed);
    bridges.append(...etc.querySelectorAll(":scope > path, :scope > line"));
    boxLayer.append(...etc.querySelectorAll(":scope > rect"));
    routed.append(lineLayer, mapLayer("transfer"), mapLayer("station"), bridges);
    legend.before(boxLayer);
    svg.append(defs, markLayer);

    for (const element of textLayer.querySelectorAll(":scope > g")) {
        const { x, y, width, height } = element.getBBox();
        labels.push({ element, x: x + width / 2, y: y + height / 2, dimmed: false });
    }

    for (const lineData of Object.values(lines)) {
        for (const positions of [lineData.positions ?? {}, ...Object.values(lineData.servicePositions ?? {})]) {
            for (const [id, [x, y]] of Object.entries(positions)) {
                platforms.push([x, y, id]);
                if (!platformsOf.has(id)) platformsOf.set(id, []);
                platformsOf.get(id).push([x, y]);
            }
        }
    }

    for (const p of platforms) {
        const key = Math.floor(p[0] / CELL) * 0x10000 + Math.floor(p[1] / CELL);
        let bucket = grid.get(key);
        if (!bucket) grid.set(key, (bucket = []));
        bucket.push(p);
    }

    Object.assign(view, { x: mapX, y: mapY, w: mapW });
    shown = { ...view };
    addEventListener("scroll", () => { originDirty = true; }, { passive: true, capture: true });
    addEventListener("resize", () => { originDirty = true; }, { passive: true });

    measure();
    const ratio = size.w / size.h || mapW / mapH;
    view.w = Math.max(mapW, mapH * ratio);
    view.x = mapX + (mapW - view.w) / 2;
    view.y = mapY + (mapH - view.w / ratio) / 2;
    if (mobile.matches && size.w) view.y += (innerHeight - panel.getBoundingClientRect().top) / 2 * view.w / size.w;
    commit();
    new ResizeObserver(() => { measure(); commit(); }).observe(svg);

    svg.addEventListener("wheel", (e) => {
        e.preventDefault();
        if (e.deltaY === 0) return;
        let delta = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 100 : 1);
        if (e.ctrlKey) delta *= 4;
        const p = toMapPoint(e);
        const w = clamp(view.w * ZOOM_STEP ** (-clamp(delta, -300, 300) / 100), mapW / 24, mapW * 2);
        const r = w / view.w;
        view.x = p.x - (p.x - view.x) * r;
        view.y = p.y - (p.y - view.y) * r;
        view.w = w;
        moveView();
    }, { passive: false });

    svg.addEventListener("pointerdown", (e) => {
        svg.setPointerCapture(e.pointerId);
        originDirty = true;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 1) {
            drag = { start: toMapPoint(e), x: e.clientX, y: e.clientY, moved: false };
        } else if (pointers.size === 2) {
            const [a, b] = pointers.values();
            pinch = {
                dist: Math.hypot(a.x - b.x, a.y - b.y),
                w: view.w,
                anchor: toMapPoint({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 }),
            };
            if (drag) drag.moved = true;
        }
    });

    svg.addEventListener("pointermove", (e) => {
        if (!pointers.has(e.pointerId)) {
            if (e.pointerType === "touch") return;
            hoverPoint = { clientX: e.clientX, clientY: e.clientY };
            if (!hoverFrame) hoverFrame = requestAnimationFrame(updateHover);
            return;
        }
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (pinch && pointers.size >= 2) {
            const [a, b] = pointers.values();
            view.w = clamp(pinch.w * pinch.dist / Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), mapW / 24, mapW * 2);
            const now = toMapPoint({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 });
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

    for (const type of ["pointerup", "pointercancel"]) {
        svg.addEventListener(type, (e) => {
            if (!pointers.delete(e.pointerId)) return;
            if (pointers.size < 2) pinch = null;
            if (pointers.size === 1) {
                const [p] = pointers.values();
                drag = { start: toMapPoint({ clientX: p.x, clientY: p.y }), x: p.x, y: p.y, moved: true };
            } else if (pointers.size === 0) {
                commit();
            }
        });
    }

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

    for (const [line, { color }] of Object.entries(lines)) {
        rgbOf[line] = `rgb(${[1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16)).join(", ")})`;
    }

    for (const group of lineLayer.children) {
        const bodies = strokeBodies(group.querySelectorAll("path, line, circle, polyline"));
        const covers = [];
        for (const { el } of bodies) {
            const cover = el.cloneNode(false);
            cover.removeAttribute("class");
            for (const [k, v] of Object.entries(COVER_STYLE)) cover.setAttribute(k, v);
            covers.push({ el: cover, box: bounds(el, COVER_PAD) });
        }
        lineGroups.push({
            color: bodies[0]?.stroke,
            bodies: bodies.map(({ el, width }) => ({ el, hit: bounds(el, width / 2 + 1, true) })),
            covers,
        });
    }

    for (const [line, lineData] of Object.entries(lines)) {
        const points = Object.values(lineData.positions ?? {}).map(([x, y]) => [x, y, new DOMPoint(x, y)]);
        let best = -1, bestCount = -1;
        for (let i = 0; i < lineGroups.length; i++) {
            const group = lineGroups[i];
            if (group.color !== rgbOf[line]) continue;
            let count = 0;
            for (const [x, y, p] of points) {
                for (const { el, hit } of group.bodies) {
                    if (hit[0] <= x && x <= hit[2] && hit[1] <= y && y <= hit[3] && el.isPointInStroke(p)) {
                        count++;
                        break;
                    }
                }
            }
            if (count > bestCount) { best = i; bestCount = count; }
        }
        groupOf[line] = best;
    }

    for (const { el, stroke } of strokeBodies(bridges.children)) {
        const mid = el.getPointAtLength(el.getTotalLength() / 2);
        const cover = el.cloneNode(false);
        cover.removeAttribute("class");
        for (const [k, v] of Object.entries(COVER_STYLE)) cover.setAttribute(k, v);
        bridgeCovers.push({ color: stroke, middle: [mid.x, mid.y], cover, box: bounds(el, COVER_PAD) });
    }

    for (const { services, loop } of Object.values(lines)) {
        if (loop) continue;
        const ends = new Set(), middles = new Set();
        for (const stops of Object.values(services)) {
            for (let i = 0; i < stops.length; i++) (i === 0 || i === stops.length - 1 ? ends : middles).add(stops[i]);
        }
        for (const station of ends) if (!middles.has(station)) terminals.add(station);
    }

    fogMask = svgEl("mask", { id: "fog-mask", maskUnits: "userSpaceOnUse", x: mapX, y: mapY, width: mapW, height: mapH });
    fog = svgEl("rect", { x: mapX, y: mapY, width: mapW, height: mapH, fill: "white", "fill-opacity": 1 - DIM_STRENGTH, mask: "url(#fog-mask)", "pointer-events": "none" });
    bgFog = svgEl("g", { opacity: 1 - DIM_STRENGTH, "pointer-events": "none" });
    defs.append(fogMask);
}

let panelDrag = null;
let panelFrame = 0;
let panelOffset = 0;

panel.addEventListener("pointerdown", (e) => {
    if (!mobile.matches || panelDrag) return;
    const fromHandle = handle.contains(e.target);
    if (!fromHandle && sheet === "full") return;
    const offsets = sheetOffsets();
    panelDrag = {
        id: e.pointerId, y: e.clientY, offsets, offset: offsets[sheet],
        lastY: e.clientY, lastTime: e.timeStamp, speed: 0, active: fromHandle,
    };
    if (fromHandle) {
        panel.setPointerCapture(e.pointerId);
        panel.classList.add("dragging");
    }
});

panel.addEventListener("pointermove", (e) => {
    const g = panelDrag;
    if (!g || e.pointerId !== g.id) return;
    const moved = e.clientY - g.y;
    if (!g.active) {
        if (Math.abs(moved) < DRAG_THRESHOLD) return;
        g.active = true;
        panel.setPointerCapture(e.pointerId);
        panel.classList.add("dragging");
    }
    panelOffset = clamp(g.offset + moved, 0, g.offsets.peek);
    if (!panelFrame) panelFrame = requestAnimationFrame(applyPanelOffset);
    g.speed = (e.clientY - g.lastY) / Math.max(1, e.timeStamp - g.lastTime);
    g.lastY = e.clientY;
    g.lastTime = e.timeStamp;
});

panel.addEventListener("pointerup", (e) => {
    const g = panelDrag;
    if (!g || e.pointerId !== g.id) return;
    panelDrag = null;
    cancelAnimationFrame(panelFrame);
    panelFrame = 0;
    panel.classList.remove("dragging");
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
    cancelAnimationFrame(panelFrame);
    panelFrame = 0;
    panel.classList.remove("dragging");
    setSheet(sheet);
});

mobile.addEventListener("change", () => setSheet("peek"));

document.getElementById("random").addEventListener("click", () => {
    showRoute(
        searchables[Math.floor(Math.random() * searchables.length)].id,
        searchables[Math.floor(Math.random() * searchables.length)].id,
    );
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

function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
}

function svgEl(tag, attrs = {}) {
    const el = document.createElementNS(NS, tag);
    for (const key in attrs) el.setAttribute(key, attrs[key]);
    return el;
}

function closeSuggestOnBlur(input) {
    if (suggestInput === input && document.activeElement !== input) closeSuggest();
}

function setStation(input, id) {
    const { st, en } = stations[id] ?? {};
    input.value = id ? [st, en].filter(Boolean).join(" ") || id : "";
    input.dataset.id = id ?? "";
}

function closeSuggest() {
    suggest.replaceChildren();
    suggest.hidden = true;
    suggestInput = null;
    suggestIndex = -1;
}

function openSuggest(input) {
    const query = input.value.trim().toLowerCase();
    if (!query) return closeSuggest();

    const starts = [], contains = [];
    for (const item of searchables) {
        if (item.keys.some((key) => key.startsWith(query))) starts.push(item);
        else if (item.keys.some((key) => key.includes(query))) contains.push(item);
    }

    const items = [];
    for (const { id, label } of [...starts, ...contains]) {
        const li = document.createElement("li");
        li.textContent = label;
        li.dataset.id = id;
        items.push(li);
    }
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

function showRoute(departure, destination) {
    setStation(departureInput, departure);
    setStation(destinationInput, destination);
    markStation("departure", departure);
    markStation("destination", destination);

    const dist = new Map();
    const prev = new Map();
    const heap = [];
    const target = `${destination}|`;
    let seq = 0;
    let goal = null, total = 0;

    for (const { key } of occurrences.get(departure) ?? []) {
        if (dist.has(key)) continue;
        dist.set(key, 0);
        prev.set(key, null);
        heap.push([0, seq++, key]);
    }

    while (heap.length > 0) {
        const top = heap[0];
        const last = heap.pop();
        const n = heap.length;
        if (n > 0) {
            let k = 0;
            for (;;) {
                let m = 2 * k + 1;
                if (m >= n) break;
                if (m + 1 < n && (heap[m + 1][0] < heap[m][0] || (heap[m + 1][0] === heap[m][0] && heap[m + 1][1] < heap[m][1]))) m++;
                if (!(heap[m][0] < last[0] || (heap[m][0] === last[0] && heap[m][1] < last[1]))) break;
                heap[k] = heap[m];
                k = m;
            }
            heap[k] = last;
        }

        const [d, , cur] = top;
        if (d > dist.get(cur)) continue;
        if (cur.startsWith(target)) {
            goal = cur;
            total = d;
            break;
        }

        let neighbors = neighborCache.get(cur);
        if (!neighbors) {
            const [station, line, service, at] = cur.split("|");
            const { services, oneway, loop, distances, velocities, dwells } = lines[line];
            const stops = services[service];
            const ranges = oneway?.[service];
            const here = occurrences.get(station) ?? [];
            const found = new Map();
            for (const o of here) if (o.key !== cur) found.set(o.key, o.line === line ? PLATFORM_COST : TRANSFER_COST);

            const indexes = at === undefined ? here.filter((o) => o.line === line && o.service === service).map((o) => o.i) : [Number(at)];
            for (const i of indexes) {
                for (const j of [i - 1, i + 1]) {
                    if (j < 0 || j >= stops.length) continue;
                    if (j < i && ranges?.some(([a, b]) => a <= j && i <= b)) continue;

                    const [from, to] = j < i ? [stops[j], station] : [station, stops[j]];
                    const raw = distances?.[to] - distances?.[from];
                    const distance = loop && raw < 0 ? loop + raw : raw;
                    let cost = MOVE_COST;
                    if (Number.isNaN(distance) || distance <= 0) {
                        if (DEBUG) console.warn(`${Number.isNaN(distance) ? "거리 정보 없음" : "거리가 음수임"}: ${line} ${service} ${from} → ${to}`);
                    } else {
                        cost = distance / (velocities?.[service] ?? 1) + (dwells?.[service] ?? 1);
                    }
                    found.set(`${stops[j]}|${line}|${service}${ranges !== undefined ? `|${j}` : ""}`, cost);
                }
            }
            neighbors = [...found];
            neighborCache.set(cur, neighbors);
        }

        for (const [next, cost] of neighbors) {
            const nd = d + cost;
            const old = dist.get(next);
            if (old !== undefined && nd >= old) continue;
            dist.set(next, nd);
            prev.set(next, cur);

            let k = heap.length;
            const item = [nd, seq++, next];
            heap.push(item);
            while (k > 0) {
                const p = (k - 1) >> 1;
                if (nd >= heap[p][0]) break;
                heap[k] = heap[p];
                k = p;
            }
            heap[k] = item;
        }
    }

    if (goal === null) {
        result.replaceChildren("No route found");
        highlightRoute(null);
        return;
    }

    const path = [];
    for (let cur = goal; cur !== null; cur = prev.get(cur)) path.push(cur.split("|"));
    path.reverse();

    const list = document.createElement("div");
    list.append(`Total: ${Math.floor(total / 60)}h ${Math.floor(total % 60)}m ${Math.floor(total * 60 % 60)}s`);

    for (let i = 0; i < path.length; i++) {
        const stationList = document.createElement("div");
        for (; i < path.length; i++) {
            const id = path[i][0];
            const { st, en } = stations[id] ?? {};
            const row = document.createElement("span");
            row.className = "station-row";
            row.textContent = [st, en].filter(Boolean).join(" ") || id;
            stationList.append(row);
            if (i === path.length - 1 || id === path[i + 1][0]) break;
        }

        const [, line, service] = path[i];
        const lineData = lines[line];
        const color = lineData.color;
        const count = stationList.childElementCount;
        const h = 32 * count;

        const diagram = svgEl("svg", { width: "2rem", height: `${2 * count}rem`, viewBox: `0 0 32 ${h}` });
        diagram.append(svgEl("path", { d: `M16 16V${h - 16}`, fill: "none", stroke: color, "stroke-width": 8 }));
        const subcolor = lineData.subcolor?.[service];
        if (subcolor !== undefined) {
            diagram.append(svgEl("path", {
                d: `M8 24V${h - 24}`, fill: "none", stroke: subcolor, "stroke-width": 2, "stroke-linecap": "round",
            }));
        }
        for (let j = 0; j < count; j++) {
            const cy = 32 * j + 16;
            diagram.append(svgEl("circle", j === 0 || j === count - 1
                ? { cx: 16, cy, r: 6, fill: "white", stroke: color, "stroke-width": 4 }
                : { cx: 20, cy, r: 4, fill: "white" }));
        }

        const icon = document.createElement("div");
        const [iconClass, iconMode, iconText = ""] = lineData.icon ?? [];
        if (iconClass) icon.classList.add(iconClass);
        if (iconMode === "background") icon.style.backgroundColor = color;
        if (iconMode === "outline" || iconMode === "text") icon.style.outlineColor = color;
        if (iconMode === "text") icon.style.color = color;
        icon.append(iconText);

        const header = document.createElement("div");
        header.className = "line-row";
        header.append(icon, `${lineData.st ?? line} ${lineData.en ?? ""}`.trim());

        const box = document.createElement("div");
        box.className = "line-box";
        box.append(diagram, stationList);
        list.append(header, box);
    }

    result.replaceChildren(list);
    highlightRoute(path);
}

function sheetOffsets() {
    const height = panel.offsetHeight;
    let searchTop = 0;
    for (let node = searchBox; node && node !== panel; node = node.offsetParent) searchTop += node.offsetTop;
    const peek = Math.max(0, height - (searchTop + searchBox.offsetHeight + 16));
    const half = Math.min(peek, Math.max(0, height - innerHeight * 0.5));
    return { peek, half, full: 0 };
}

function setSheet(state = sheet) {
    sheet = state;
    panel.classList.toggle("full", sheet === "full");
    panel.style.transform = mobile.matches ? `translateY(${sheetOffsets()[sheet]}px)` : "";
    if (mobile.matches && sheet !== "full") panelBody.scrollTop = 0;
}

function applyPanelOffset() {
    panelFrame = 0;
    if (panelDrag) panel.style.transform = `translateY(${panelOffset}px)`;
}

function mapLayer(id) {
    let g = svg.querySelector(`:scope > #${id}`);
    if (!g) svg.append((g = svgEl("g")));
    return g;
}

function round2(v) {
    return +v.toFixed(2);
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

    let d = `M${round2(pts[0][0])} ${round2(pts[0][1])}`;
    for (let i = 1; i < m; i++) {
        const [x, y] = pts[i];
        if (cut[i] === 0) {
            d += `L${round2(x)} ${round2(y)}`;
            continue;
        }
        const [px, py] = pts[i - 1], [nx, ny] = pts[i + 1];
        const l1 = Math.hypot(x - px, y - py), l2 = Math.hypot(nx - x, ny - y);
        const r = cut[i] / Math.tan(Math.abs(turn[i]) / 2);
        d += `L${round2(x - (x - px) / l1 * cut[i])} ${round2(y - (y - py) / l1 * cut[i])}`;
        d += `A${round2(r)} ${round2(r)} 0 0 ${turn[i] > 0 ? 1 : 0} ${round2(x + (nx - x) / l2 * cut[i])} ${round2(y + (ny - y) / l2 * cut[i])}`;
    }
    return d;
}

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

function measure() {
    const rect = svg.getBoundingClientRect();
    origin = {
        left: rect.left - (shift?.x ?? 0) + svg.clientLeft,
        top: rect.top - (shift?.y ?? 0) + svg.clientTop,
    };
    size = { w: svg.clientWidth, h: svg.clientHeight };
    originDirty = false;
}

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
        if (!frame) frame = requestAnimationFrame(commit);
        return;
    }
    if (!frame) frame = requestAnimationFrame(renderLive);
    clearTimeout(commitTimer);
    commitTimer = setTimeout(commit, COMMIT_DELAY);
}

function toMapPoint({ clientX, clientY }) {
    if (originDirty) measure();
    const s = view.w / size.w;
    return { x: view.x + (clientX - origin.left) * s, y: view.y + (clientY - origin.top) * s };
}

function updateHover() {
    hoverFrame = 0;
    const cursor = nearestStation(toMapPoint(hoverPoint)) !== null ? "pointer" : "";
    if (cursor !== hoverCursor) svg.style.cursor = hoverCursor = cursor;
}

function nearestStation({ x, y }) {
    const reach = (coarsePointer.matches ? 22 : 12) * view.w / size.w;
    const limit = Math.max(8, reach);
    let best = null, bestSq = limit * limit;

    const x0 = Math.floor((x - limit) / CELL), x1 = Math.floor((x + limit) / CELL);
    const y0 = Math.floor((y - limit) / CELL), y1 = Math.floor((y + limit) / CELL);
    const buckets = [];
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > grid.size) {
        buckets.push(platforms);
    } else {
        for (let cx = x0; cx <= x1; cx++) {
            for (let cy = y0; cy <= y1; cy++) {
                const bucket = grid.get(cx * 0x10000 + cy);
                if (bucket) buckets.push(bucket);
            }
        }
    }
    for (const bucket of buckets) {
        for (const [px, py, id] of bucket) {
            const d = (px - x) ** 2 + (py - y) ** 2;
            if (d < bestSq) { best = id; bestSq = d; }
        }
    }
    return best;
}

function markStation(kind, id) {
    marks[kind]?.remove();
    marks[kind] = null;
    if (!platformsOf.has(id)) return;
    const mark = svgEl("path", { d: stationShape(id), class: `station-mark ${kind}` });
    markLayer.append(mark);
    marks[kind] = mark;
}

function strokeBodies(elements) {
    const list = [];
    for (const el of elements) {
        const s = getComputedStyle(el);
        if (s.stroke !== "none" && s.stroke !== "rgb(255, 255, 255)" && s.strokeDasharray === "none") {
            list.push({ el, stroke: s.stroke, width: parseFloat(s.strokeWidth) || 1 });
        }
    }
    return list;
}

function bounds(el, pad, local = false) {
    const b = el.getBBox();
    let box = [b.x, b.y, b.x + b.width, b.y + b.height];
    const list = el.transform?.baseVal;
    if (!local && list?.numberOfItems) {
        let m = new DOMMatrix();
        for (let i = 0; i < list.numberOfItems; i++) m = m.multiply(list.getItem(i).matrix);
        let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
        for (const [x, y] of [[box[0], box[1]], [box[2], box[1]], [box[0], box[3]], [box[2], box[3]]]) {
            const p = m.transformPoint({ x, y });
            x1 = Math.min(x1, p.x);
            y1 = Math.min(y1, p.y);
            x2 = Math.max(x2, p.x);
            y2 = Math.max(y2, p.y);
        }
        box = [x1, y1, x2, y2];
    }
    return [box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad];
}

function highlightRoute(path) {
    if (svg === null) return;

    if (path === null) {
        if (fogShown) {
            fogShown = false;
            fog.remove();
            bgFog.remove();
            fogMask.replaceChildren();
            bgFog.replaceChildren();
        }
        legend.style.removeProperty("opacity");
        if (legend.getAttribute("style") === "") legend.removeAttribute("style");
    } else {
        const rides = new Map();
        const passed = new Set(path.map(([station]) => station));
        for (let i = 1; i < path.length; i++) {
            const [a, line, service, ai] = path[i - 1];
            const [b, nextLine, nextService, bi] = path[i];
            if (line !== nextLine || service !== nextService || a === b) continue;

            const lineData = lines[line];
            let stops;
            if (bi !== undefined) {
                const all = lineData.services[service];
                const from = Number(ai), to = Number(bi);
                stops = from <= to ? all.slice(from, to + 1) : all.slice(to, from + 1).reverse();
            } else {
                stops = [a, b];
                for (const list of Object.values(lineData.services)) {
                    const as = [], bs = [];
                    for (let k = 0; k < list.length; k++) {
                        if (list[k] === a) as.push(k);
                        if (list[k] === b) bs.push(k);
                    }
                    let range = null;
                    for (const p of as) {
                        for (const q of bs) {
                            if (range === null || Math.abs(p - q) < Math.abs(range[0] - range[1])) range = [p, q];
                        }
                    }
                    if (range === null) continue;
                    const [p, q] = range;
                    const part = p < q ? list.slice(p, q + 1) : list.slice(q, p + 1).reverse();
                    if (part.length > stops.length) stops = part;
                }
            }
            for (const station of stops) passed.add(station);

            const points = [];
            for (let j = 1; j < stops.length; j++) {
                const s = stops[j - 1], t = stops[j];
                const ps = lineData.servicePositions?.[service]?.[s] ?? lineData.positions?.[s];
                const pt = lineData.servicePositions?.[service]?.[t] ?? lineData.positions?.[t];
                if (!ps || !pt) continue;
                const bends = lineData.bends?.[`${s}|${t}`] ?? [...(lineData.bends?.[`${t}|${s}`] ?? [])].reverse();
                points.push(ps, ...bends, pt);
            }
            if (points.length === 0) continue;

            let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
            for (const [x, y] of points) {
                if (x < x1) x1 = x;
                if (y < y1) y1 = y;
                if (x > x2) x2 = x;
                if (y > y2) y2 = y;
            }
            if (!rides.has(line)) rides.set(line, []);
            rides.get(line).push({
                points,
                d: pathOf(points),
                box: [x1 - ROUTE_WIDTH, y1 - ROUTE_WIDTH, x2 + ROUTE_WIDTH, y2 + ROUTE_WIDTH],
            });
        }

        const mask = [svgEl("rect", { x: mapX, y: mapY, width: mapW, height: mapH, fill: "white" })];
        const holes = [];
        const holeBoxes = [];

        const ridesByGroup = new Map();
        for (const [line, list] of rides) {
            const g = groupOf[line];
            if (!ridesByGroup.has(g)) ridesByGroup.set(g, []);
            ridesByGroup.get(g).push(...list);
        }
        for (const g of [...lineGroups.keys(), -1]) {
            for (const { el, box } of lineGroups[g]?.covers ?? []) {
                if (holeBoxes.some((h) => h[0] <= box[2] && box[0] <= h[2] && h[1] <= box[3] && box[1] <= h[3])) mask.push(el);
            }
            for (const { d, box } of ridesByGroup.get(g) ?? []) {
                holes.push(svgEl("path", { ...STROKE_STYLE, d, stroke: "white", "stroke-width": ROUTE_WIDTH }));
                mask.push(svgEl("path", { ...STROKE_STYLE, d, stroke: "black", "stroke-width": ROUTE_WIDTH }));
                holeBoxes.push(box);
            }
        }

        for (const { color, middle: [mx, my], cover, box } of bridgeCovers) {
            let used = false;
            for (const [line, list] of rides) {
                if (used) break;
                if (rgbOf[line] !== color) continue;
                for (const { points } of list) {
                    let nearest = Infinity;
                    for (let k = 1; k < points.length; k++) {
                        const [px1, py1] = points[k - 1], [px2, py2] = points[k];
                        const dx = px2 - px1, dy = py2 - py1;
                        const t = clamp(((mx - px1) * dx + (my - py1) * dy) / (dx * dx + dy * dy || 1), 0, 1);
                        nearest = Math.min(nearest, Math.hypot(mx - px1 - t * dx, my - py1 - t * dy));
                    }
                    if (nearest < 3) {
                        used = true;
                        break;
                    }
                }
            }
            if (used) continue;
            if (holeBoxes.some((h) => h[0] <= box[2] && box[0] <= h[2] && h[1] <= box[3] && box[1] <= h[3])) mask.push(cover);
        }

        for (const station of passed) {
            const count = platformsOf.get(station)?.length ?? 0;
            const width = count > 1 ? TRANSFER_WIDTH : count === 1 && terminals.has(station) ? TERMINAL_WIDTH : 0;
            if (width === 0) continue;
            const d = stationShape(station);
            holes.push(svgEl("path", { ...STROKE_STYLE, d, stroke: "white", "stroke-width": width }));
            mask.push(svgEl("path", { ...STROKE_STYLE, d, stroke: "black", "stroke-width": width }));
        }

        fogMask.replaceChildren(...mask);
        bgFog.replaceChildren(...holes);
        if (!fogShown) {
            fogShown = true;
            routed.after(fog);
            routed.before(bgFog);
        }
        legend.style.opacity = DIM_STRENGTH;
    }

    const boxes = path === null ? [] : path.map(([station]) => stations[station]?.box).filter(Boolean);
    for (const label of labels) {
        const dim = path !== null && !boxes.some(([x1, y1, x2, y2]) => x1 <= label.x && label.x <= x2 && y1 <= label.y && label.y <= y2);
        if (label.dimmed === dim) continue;
        label.dimmed = dim;
        if (dim) {
            label.element.style.opacity = DIM_STRENGTH;
        } else {
            label.element.style.removeProperty("opacity");
            if (label.element.getAttribute("style") === "") label.element.removeAttribute("style");
        }
    }
}
