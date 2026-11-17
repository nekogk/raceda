const city = location.pathname.split("/").filter(Boolean)[0];
const stations = await (await fetch(`/${city}/stations.json`)).json();
const lines = await (await fetch(`/${city}/lines.json`)).json();
const mapResponse = await fetch(`/${city}/map.svg`);
const result = document.getElementById("result");
const departureInput = document.getElementById("departure");
const destinationInput = document.getElementById("destination");
const suggest = document.getElementById("suggest");
const searchables = setSearch();

const panel = document.getElementById("panel");
const handle = document.getElementById("handle");
const mobile = matchMedia("(max-width: 768px)");
const sheets = ["peek", "half", "full"];
let sheet = "peek";
let start = null;

function sheetOffsets() {
    const height = panel.offsetHeight;
    const search = document.getElementById("search");
    const peek = Math.max(0, height - (search.offsetTop + search.offsetHeight + 16));
    const half = Math.min(peek, Math.max(0, height - innerHeight * 0.5));
    return { peek, half, full: 0 };
}

function setSheet(state = sheet) {
    sheet = state;
    panel.style.transform = mobile.matches ? `translateY(${sheetOffsets()[sheet]}px)` : "";
    if (mobile.matches && sheet !== "full") panel.scrollTop = 0;
}

function checkMissingStations() {
  const missing = new Map();

  for (const [lineId, lineData] of Object.entries(lines)) {
    for (const [serviceId, serviceData] of Object.entries(lineData.services)) {
      for (const id of serviceData) {
        if (Object.hasOwn(stations, id)) continue;
        if (!missing.has(id)) missing.set(id, []);
        missing.get(id).push(`${lineId}.${serviceId}`);
      }
    }
  }

  if (missing.size !== 0) {
    for (const [id, data] of missing) {
      //console.warn(`역 정보 없음: ${id} (${[...new Set(data)].join(", ")})`);
    }
  }

  return;
}

const moveCost = 3;
const platformCost = 5;
const transferCost = 7;

function segmentCost(line, service, prev, next) {
    const distance = lines[line].distances?.[next] - lines[line].distances?.[prev]
    const velocity = lines[line].velocities?.[service] ?? 1;
    const dwell = lines[line].dwells?.[service] ?? 1;
    const loop = lines[line].loop;
    
    if (Number.isNaN(distance)) {
        //console.warn(`거리 정보 없음: ${line} ${service} ${prev} → ${next}`);
        return moveCost;
    }
    if (distance <= 0) {
        //console.warn(`거리가 음수임: ${line} ${service} ${prev} → ${next}`);
        return moveCost;
    }

    return (loop && distance < 0 ? loop + distance : distance) / velocity + dwell;
}

function getNeighbors(key) {
    const [station, line, service] = key.split("|");
    const stops = lines[line].services[service];
    const neighbors = new Map();

    for (const [lineId, lineData] of Object.entries(lines)) {
        for (const [serviceId, serviceData] of Object.entries(lineData.services)) {
            if (!serviceData.includes(station)) continue;
            if (lineId === line && serviceId === service) continue;
            neighbors.set(`${station}|${lineId}|${serviceId}`, lineId === line ? platformCost : transferCost);
        }
    }

    for (let i = 0; i < stops.length; i++) {
        if (stops[i] !== station) continue;
        if (i > 0) neighbors.set(`${stops[i - 1]}|${line}|${service}`, segmentCost(line, service, stops[i - 1], station));
        if (i < stops.length - 1) neighbors.set(`${stops[i + 1]}|${line}|${service}`, segmentCost(line, service, station, stops[i + 1]));
    }

    return neighbors;
}

function getRoute(from, to) {
    const dist = new Map();
    const prev = new Map();
    const queue = new Set();

    for (const [lineId, lineData] of Object.entries(lines)) {
        for (const [serviceId, serviceData] of Object.entries(lineData.services)) {
            if (serviceData.includes(from)) {
                const key = `${from}|${lineId}|${serviceId}`;
                dist.set(key, 0);
                prev.set(key, null);
                queue.add(key);
            }
        }
    }
    
    while (queue.size > 0) {
        const cur = [...queue].reduce((best, i) => dist.get(i) < dist.get(best) ? i : best);
        queue.delete(cur);

        if (cur.split("|")[0] === to) return [cur, prev, dist.get(cur)];

        for (const [next, cost] of getNeighbors(cur)) {
            const d = dist.get(cur) + cost;
            if (!dist.has(next) || d < dist.get(next)) {
                dist.set(next, d);
                prev.set(next, cur);
                queue.add(next);
            }
        }
    }

    return;
}

function buildPath(goal, prev, dist) {
    const path = [];
    for (let cur = goal; cur !== null; cur = prev.get(cur)) path.push(cur.split("|"));
    path.reverse();

    const lineList = document.createElement("div");
    const NS = "http://www.w3.org/2000/svg";

    lineList.append(`Total: ${Math.floor(dist / 60)}h ${Math.floor(dist % 60)}m ${Math.floor(dist * 60 % 60)}s`);

    for (let i = 0; i < path.length; i++) {
        const lineBox = document.createElement("div");
        const stationList = document.createElement("div");
        const lineIcon = document.createElement("div");
        const lineRow = document.createElement("div");

        lineBox.classList.add("line-box");
        lineRow.classList.add("line-row");

        for (;i < path.length; i++) {
            const stationRow = document.createElement("text");
            stationRow.classList.add("station-row");
            stationRow.append(document.createTextNode(`${stations[path[i][0]].st ?? path[i][0]} ${stations[path[i][0]].en ?? ""}`.trim()));
            stationList.append(stationRow)
            if (i === path.length - 1 || path[i][0] === path[i + 1][0]) break;
        }
    
        const stationCount = stationList.childElementCount;
        const lineColor = lines[path[i][1]].color;
        const svgElement = document.createElementNS(NS, "svg");
        svgElement.setAttribute("width", "2rem");
        svgElement.setAttribute("height", `${2 * stationCount}rem`);
        svgElement.setAttribute("viewBox", `0 0 32 ${32 * stationCount}`);

        const lineElement = document.createElementNS(NS, "path");
        lineElement.setAttribute("d", `M 16 16 16 ${32 * stationCount - 16}`);
        lineElement.setAttribute("fill", "none");
        lineElement.setAttribute("stroke", lineColor);
        lineElement.setAttribute("stroke-width", 8);
        svgElement.append(lineElement);
        
        if (lines[path[i][1]].subcolor?.[path[i][2]] !== undefined) {
            const serviceElement = document.createElementNS(NS, "path");
            serviceElement.setAttribute("d", `M 8 24 8 ${32 * stationCount - 24}`);
            serviceElement.setAttribute("fill", "none");
            serviceElement.setAttribute("stroke", lines[path[i][1]].subcolor[path[i][2]]);
            serviceElement.setAttribute("stroke-width", 2);
            serviceElement.setAttribute("stroke-linecap", "round");
            svgElement.append(serviceElement);
        }

        for (let j = 0; j < stationCount; j++) {
            const stationElement = document.createElementNS(NS, "circle");

            stationElement.setAttribute("cy", 32 * j + 16);
            stationElement.setAttribute("fill", "white");

            if (j === 0 || j === stationCount -1) {
                stationElement.setAttribute("cx", 16);
                stationElement.setAttribute("stroke", lineColor);
                stationElement.setAttribute("r", 6);
                stationElement.setAttribute("stroke-width", 4);
            } else {
                stationElement.setAttribute("cx", 20);
                stationElement.setAttribute("r", 4);
            }

            svgElement.append(stationElement)
        }

        lineIcon.classList.add(lines[path[i][1]].icon[0]);
        if (lines[path[i][1]].icon[1] === "background") lineIcon.style.backgroundColor = lineColor;
        if (lines[path[i][1]].icon[1] === "outline") lineIcon.style.outlineColor = lineColor;
        if (lines[path[i][1]].icon[1] === "text") {
            lineIcon.style.outlineColor = lineColor;
            lineIcon.style.color = lineColor;
        }

        lineIcon.append(lines[path[i][1]].icon[2]);
        lineRow.append(lineIcon, document.createTextNode(`${lines[path[i][1]].st ?? path[i][1]} ${lines[path[i][1]].en ?? ""}`.trim()))
        lineBox.append(svgElement, stationList)
        lineList.append(lineRow, lineBox);
    }

    return lineList;
}

function stationLabel(id) {
    const { st, en } = stations[id] ?? {};
    return [st, en].filter(Boolean).join(" ") || id;
}

function setStation(input, id) {
    input.value = id ? stationLabel(id) : "";
    input.dataset.id = id ?? "";
}

function setSearch() {
    const search = [];
    const used = new Set();
    for (const { services } of Object.values(lines)) {
        for (const stops of Object.values(services)) for (const id of stops) used.add(id);
    }
    for (const id of Object.keys(stations)) {
        if (!used.has(id)) continue;
        const { st, en } = stations[id];
        const named = Boolean(st || en);
        search.push({ id, label: stationLabel(id), keys: named ? [st, en] : [id] });
    }
    return search;
}

let suggestInput = null;
let suggestIndex = -1;

function closeSuggest() {
    suggest.replaceChildren();
    suggest.hidden = true;
    suggestInput = null;
    suggestIndex = -1;
}

function chooseSuggest(input, id) {
    setStation(input, id);
    closeSuggest();
    if (input === departureInput) markStation("departure", id);
    else markStation("destination", id);
}

function openSuggest(input) {
    const query = input.value.trim().toLowerCase();
    if (!query) return closeSuggest();

    const starts = [], contains = [];
    for (const item of searchables) {
        const keys = item.keys.filter(Boolean).map((key) => key.toLowerCase());
        if (keys.some((key) => key.startsWith(query))) starts.push(item);
        else if (keys.some((key) => key.includes(query))) contains.push(item);
    }
    const matches = [...starts, ...contains];

    suggest.replaceChildren();
    for (const { id, label } of matches) {
        const li = document.createElement("li");
        li.textContent = label;
        li.dataset.id = id;

        li.addEventListener("click", () => chooseSuggest(input, id));
        suggest.append(li);
    }
    if (matches.length === 0) {
        const li = document.createElement("li");
        li.className = "empty";
        li.textContent = "No results";
        suggest.append(li);
    }

    suggestInput = input;
    suggestIndex = -1;
    suggest.style.top = `${input.offsetTop + input.offsetHeight}px`;
    suggest.style.left = `${input.offsetLeft}px`;
    suggest.style.width = `${input.offsetWidth}px`;
    suggest.hidden = false;
}

function moveSuggest(step) {
    const items = [...suggest.querySelectorAll("li[data-id]")];
    if (items.length === 0) return;
    suggestIndex = (suggestIndex + step + items.length) % items.length;
    items.forEach((li, i) => li.classList.toggle("active", i === suggestIndex));
    items[suggestIndex].scrollIntoView({ block: "nearest" });
}

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
    input.addEventListener("keydown", (event) => {
        if (suggestInput !== input) return;
        if (event.key === "ArrowDown") moveSuggest(1);
        else if (event.key === "ArrowUp") moveSuggest(-1);
        else if (event.key === "Enter" && suggestIndex >= 0) {
            chooseSuggest(input, suggest.querySelectorAll("li[data-id]")[suggestIndex].dataset.id);
        } else if (event.key === "Escape") closeSuggest();
        else return;
        event.preventDefault();
    });
}
closeSuggest();

function showRoute(departure, destination) {
    setStation(departureInput, departure);
    setStation(destinationInput, destination);
    const route = getRoute(departure, destination);
    markStation("departure", departure);
    markStation("destination", destination);
    if (route === undefined) {
        result.replaceChildren("No route found");
        highlightRoute(null);
        return;
    }
    result.replaceChildren(buildPath(route[0], route[1], route[2]));

    const path = [];
    for (let cur = route[0]; cur !== null; cur = route[1].get(cur)) path.push(cur.split("|"));
    highlightRoute(path.reverse());
}

let highlightRoute = () => {};
let markStation = () => {};

const NS = "http://www.w3.org/2000/svg";
const ROUTE_WIDTH = 7;
const STATION_WIDTH = 15;
const TERMINAL_WIDTH = 13;
const DIM = 0.2;

if (mapResponse.ok) setupMap(new DOMParser().parseFromString(await mapResponse.text(), "image/svg+xml").documentElement);
else document.getElementById("map").hidden = true;

function setupMap(svg) {
    const [mapX, mapY, mapW, mapH] = svg.getAttribute("viewBox").split(/[\s,]+/).map(Number);
    document.getElementById("map").append(svg);

    const layer = (id) => svg.querySelector(`:scope > #${id}`) ?? document.createElementNS(NS, "g");
    const background = layer("background"), lineLayer = layer("line"), legend = layer("legend"), textLayer = layer("text"), etc = layer("etc");

    const defs = document.createElementNS(NS, "defs");
    const routed = document.createElementNS(NS, "g");
    const bridges = document.createElementNS(NS, "g");
    const markLayer = document.createElementNS(NS, "g");

    lineLayer.before(routed);
    bridges.append(...etc.querySelectorAll(":scope > path, :scope > line"));
    textLayer.prepend(...etc.querySelectorAll(":scope > rect"));
    routed.append(lineLayer, layer("transfer"), layer("station"), bridges);
    textLayer.before(markLayer);
    svg.append(defs);

    const labels = [...textLayer.querySelectorAll(":scope > g")].map((element) => {
        const { x, y, width, height } = element.getBBox();
        return { element, x: x + width / 2, y: y + height / 2 };
    });

    const platforms = [];
    const platformsOf = new Map();
    for (const lineData of Object.values(lines)) {
        for (const [id, [x, y]] of Object.entries(lineData.positions ?? {})) {
            platforms.push([x, y, id]);
            if (!platformsOf.has(id)) platformsOf.set(id, []);
            platformsOf.get(id).push([x, y]);
        }
    }

    function pathOf(points) {
        const pts = points.filter((p, i) => i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1]);
        const m = pts.length;
        if (m === 1) return `M${pts[0][0]} ${pts[0][1]}L${pts[0][0]} ${pts[0][1]}`;
        const cut = new Array(m).fill(0);
        const turn = new Array(m).fill(0);
        for (let i = 1; i < m - 1; i++) {
            const n = pts[i][2];
            if (!n) continue;
            const a1 = Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]);
            const a2 = Math.atan2(pts[i + 1][1] - pts[i][1], pts[i + 1][0] - pts[i][0]);
            const d = Math.atan2(Math.sin(a2 - a1), Math.cos(a2 - a1));
            if (Math.abs(d) < 1e-6) continue;
            turn[i] = d;
            cut[i] = n * Math.tan(Math.abs(d) / 2);
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

    function stationShape(id) {
        const points = platformsOf.get(id);
        const joined = [points[0]], rest = points.slice(1);
        let d = pathOf([points[0], points[0]]);
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
        return d;
    }

    const view = { x: mapX, y: mapY, w: mapW };

    function applyView() {
        if (svg.clientWidth === 0) return;
        const h = view.w * svg.clientHeight / svg.clientWidth;
        svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${h}`);
    }

    const ratio = svg.clientWidth / svg.clientHeight;
    view.w = Math.max(mapW, mapH * ratio);
    view.x = mapX + (mapW - view.w) / 2;
    view.y = mapY + (mapH - view.w / ratio) / 2;

    if (mobile.matches) view.y += (innerHeight - panel.getBoundingClientRect().top) / 2 * view.w / svg.clientWidth;
    applyView();
    new ResizeObserver(applyView).observe(svg);

    function toMapPoint(e) {
        return new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
    }

    svg.addEventListener("wheel", (e) => {
        e.preventDefault();
        const p = toMapPoint(e);
        const w = Math.min(mapW * 2, Math.max(mapW / 24, view.w * (e.deltaY < 0 ? 0.85 : 1 / 0.85)));
        const r = w / view.w;
        view.x = p.x - (p.x - view.x) * r; 
        view.y = p.y - (p.y - view.y) * r;
        view.w = w;
        applyView();
    }, { passive: false });

    const clampW = (w) => Math.min(mapW * 2, Math.max(mapW / 24, w));
    const pointers = new Map();
    const middle = () => {
        const [a, b] = [...pointers.values()];
        return { clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2, dist: Math.hypot(a.x - b.x, a.y - b.y) };
    };
    let drag = null, pinch = null;

    svg.addEventListener("pointerdown", (e) => {
        svg.setPointerCapture(e.pointerId);
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 1) {
            drag = { start: toMapPoint(e), x: e.clientX, y: e.clientY, moved: false };
        } else if (pointers.size === 2) {
            const m = middle();
            pinch = { dist: m.dist, w: view.w, anchor: toMapPoint(m) };
            if (drag) drag.moved = true;
        }
    });
    svg.addEventListener("pointermove", (e) => {
        if (!pointers.has(e.pointerId)) {
            svg.style.cursor = nearestStation(toMapPoint(e)) ? "pointer" : "";
            return;
        }
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pinch && pointers.size >= 2) {
            const m = middle();
            view.w = clampW(pinch.w * pinch.dist / Math.max(1, m.dist));
            applyView();
            const now = toMapPoint(m);
            view.x += pinch.anchor.x - now.x;
            view.y += pinch.anchor.y - now.y;
            applyView();
            return;
        }
        if (!drag) return;
        if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) drag.moved = true;
        if (!drag.moved) return;
        const p = toMapPoint(e);
        view.x -= p.x - drag.start.x;
        view.y -= p.y - drag.start.y;
        applyView();
    });
    const release = (e) => {
        pointers.delete(e.pointerId);
        if (pointers.size < 2) pinch = null;
        if (pointers.size === 1) {
            const [p] = pointers.values();
            drag = { start: toMapPoint({ clientX: p.x, clientY: p.y }), x: p.x, y: p.y, moved: true };
        }
    };
    svg.addEventListener("pointerup", release);
    svg.addEventListener("pointercancel", release);

    function nearestStation(p) {
        let best = null;
        const reach = matchMedia("(pointer: coarse)").matches ? 22 : 12;
        let bestDist = Math.max(8, reach * view.w / svg.clientWidth);
        for (const [x, y, id] of platforms) {
            const d = Math.hypot(x - p.x, y - p.y);
            if (d < bestDist) { best = id; bestDist = d; }
        }
        return best;
    }

    let picking = "departure";
    svg.addEventListener("click", (e) => {
        if (drag?.moved) return;
        const id = nearestStation(toMapPoint(e));
        if (id === null) {
            if (fog.style.display !== "none") {
                highlightRoute(null);
                markStation("departure", null);
                markStation("destination", null);
                setStation(departureInput, null);
                setStation(destinationInput, null);
                result.replaceChildren();
                picking = "departure";
            }
            return;
        }

        setStation(document.getElementById(picking), id);
        if (picking === "departure") {
            setStation(destinationInput, null);
            highlightRoute(null);
            markStation("departure", id);
            markStation("destination", null);
            picking = "destination";
        } else {
            showRoute(departureInput.dataset.id, id);
            picking = "departure";
        }
    });

    const marks = {};
    markStation = (kind, id) => {
        marks[kind]?.remove();
        if (!platformsOf.has(id)) return;
        const mark = document.createElementNS(NS, "path");
        mark.setAttribute("d", stationShape(id));
        mark.classList.add("station-mark", kind);
        markLayer.append(mark);
        marks[kind] = mark;
    };

    function makeMask(id) {
        const mask = document.createElementNS(NS, "mask");
        mask.id = id;
        mask.setAttribute("maskUnits", "userSpaceOnUse");
        for (const [key, value] of [["x", mapX], ["y", mapY], ["width", mapW], ["height", mapH]]) mask.setAttribute(key, value);
        defs.append(mask);
        return mask;
    }
    function makeRect(x, y, w, h, color) {
        const rect = document.createElementNS(NS, "rect");
        for (const [key, value] of [["x", x], ["y", y], ["width", w], ["height", h], ["fill", color]]) rect.setAttribute(key, value);
        return rect;
    }
    function setStroke(element, color, width) {
        for (const [key, value] of [["fill", "none"], ["stroke", color], ["stroke-width", width]]) element.setAttribute(key, value);
        return element;
    }
    function makeStroke(d, color, width) {
        const stroke = setStroke(document.createElementNS(NS, "path"), color, width);
        for (const [key, value] of [["d", d], ["stroke-linecap", "round"], ["stroke-linejoin", "round"]]) stroke.setAttribute(key, value);
        return stroke;
    }

    const toRgb = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
    const isBody = (element) => {
        const style = getComputedStyle(element);
        return style.stroke !== "none" && style.stroke !== "rgb(255, 255, 255)" && style.strokeDasharray === "none";
    };
    const makeCover = (element) => {
        const cover = element.cloneNode(false);
        cover.removeAttribute("class");
        return setStroke(cover, "white", ROUTE_WIDTH);
    };
    const lineGroups = [...lineLayer.children].map((group) => {
        const bodies = [...group.querySelectorAll("path, line, circle, polyline")].filter(isBody);
        const style = bodies.length > 0 ? getComputedStyle(bodies[0]) : null;
        return { color: style?.stroke, bodies, covers: bodies.map(makeCover) };
    });

    const groupOf = {};
    for (const [line, lineData] of Object.entries(lines)) {
        const color = toRgb(lineData.color);
        const points = Object.values(lineData.positions ?? {}).map(([x, y]) => new DOMPoint(x, y));
        let best = -1, bestCount = -1;
        lineGroups.forEach((group, i) => {
            if (group.color !== color) return;
            const count = points.filter((p) => group.bodies.some((body) => body.isPointInStroke(p))).length;
            if (count > bestCount) { best = i; bestCount = count; }
        });
        groupOf[line] = best;
    }

    const bridgeCovers = [...bridges.children].filter(isBody).map((element) => {
        const middle = element.getPointAtLength(element.getTotalLength() / 2);
        return { color: getComputedStyle(element).stroke, middle: [middle.x, middle.y], cover: makeCover(element) };
    });

    function edgePoints(line, a, b) {
        const lineData = lines[line];
        if (!lineData.positions?.[a] || !lineData.positions?.[b]) return [];
        const bends = lineData.bends?.[`${a}|${b}`] ?? [...(lineData.bends?.[`${b}|${a}`] ?? [])].reverse();
        return [lineData.positions[a], ...bends, lineData.positions[b]];
    }

    function stopsBetween(line, a, b) {
        let best = [a, b];
        for (const stops of Object.values(lines[line].services)) {
            let range = null;
            stops.forEach((s, i) => {
                if (s !== a) return;
                stops.forEach((t, j) => {
                    if (t === b && (range === null || Math.abs(i - j) < Math.abs(range[0] - range[1]))) range = [i, j];
                });
            });
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
            const t = Math.min(1, Math.max(0, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy || 1)));
            best = Math.min(best, Math.hypot(x - x1 - t * dx, y - y1 - t * dy));
        }
        return best;
    }

    const fogMask = makeMask("fog-mask");
    const bgFogMask = makeMask("bg-fog-mask");
    const makeFog = (maskId) => {
        const fog = makeRect(mapX, mapY, mapW, mapH, "white");
        fog.setAttribute("fill-opacity", 1 - DIM);
        fog.setAttribute("mask", `url(#${maskId})`);
        fog.style.pointerEvents = "none";
        fog.style.display = "none";
        return fog;
    };
    const fog = makeFog("fog-mask");
    const bgFog = makeFog("bg-fog-mask");
    routed.after(fog);
    routed.before(bgFog);

    const terminals = new Set();
    for (const { services, loop } of Object.values(lines)) {
        if (loop) continue;
        const ends = new Set(), middles = new Set();
        for (const stops of Object.values(services)) {
            stops.forEach((station, i) => (i === 0 || i === stops.length - 1 ? ends : middles).add(station));
        }
        for (const station of ends) if (!middles.has(station)) terminals.add(station);
    }

    highlightRoute = (path) => {
        if (path === null) {
            fog.style.display = bgFog.style.display = "none";
            for (const label of labels) label.element.style.opacity = "";
            legend.style.opacity = "";
            return;
        }

        const rides = new Map();
        const passedStations = new Set(path.map(([station]) => station));
        for (let i = 1; i < path.length; i++) {
            const [a, line, service] = path[i - 1];
            const [b, nextLine, nextService] = path[i];
            if (line !== nextLine || service !== nextService) continue;
            const passed = stopsBetween(line, a, b);
            for (const station of passed) passedStations.add(station);
            const points = [];
            for (let j = 1; j < passed.length; j++) points.push(...edgePoints(line, passed[j - 1], passed[j]));
            if (points.length === 0) continue;
            if (!rides.has(line)) rides.set(line, []);
            rides.get(line).push(points);
        }
        const clear = [];
        const addClear = (d, width) => {
            clear.push([d, width]);
            return makeStroke(d, "black", width);
        };
        const strokesOf = (line) => rides.get(line).map((points) => addClear(pathOf(points), ROUTE_WIDTH));

        fogMask.replaceChildren(makeRect(mapX, mapY, mapW, mapH, "white"));
        lineGroups.forEach((group, i) => {
            fogMask.append(...group.covers);
            for (const line of rides.keys()) if (groupOf[line] === i) fogMask.append(...strokesOf(line));
        });
        for (const line of rides.keys()) if (groupOf[line] < 0) fogMask.append(...strokesOf(line));

        for (const bridge of bridgeCovers) {
            const used = [...rides].some(([line, list]) =>
                toRgb(lines[line].color) === bridge.color && list.some((points) => distanceTo(points, bridge.middle) < 3));
            if (!used) fogMask.append(bridge.cover);
        }

        for (const station of passedStations) {
            const count = platformsOf.get(station)?.length ?? 0;
            if (count > 1) {
                fogMask.append(addClear(stationShape(station), STATION_WIDTH));
            } else if (count === 1 && terminals.has(station)) {
                fogMask.append(addClear(stationShape(station), TERMINAL_WIDTH));
            }
        }

        bgFogMask.replaceChildren(...clear.map(([d, width]) => makeStroke(d, "white", width)));
        fog.style.display = bgFog.style.display = "";

        legend.style.opacity = DIM;

        const boxes = path.map(([station]) => stations[station]?.box).filter(Boolean);
        for (const { element, x, y } of labels) {
            const lit = boxes.some(([x1, y1, x2, y2]) => x1 <= x && x <= x2 && y1 <= y && y <= y2);
            element.style.opacity = lit ? "" : DIM;
        }
    };
}

panel.addEventListener("pointerdown", (e) => {
    if (!mobile.matches || (e.target !== handle && e.target !== panel)) return;
    start = { y: e.clientY, offset: sheetOffsets()[sheet], time: e.timeStamp, last: e.clientY };
    panel.setPointerCapture(e.pointerId);
    panel.classList.add("dragging");
});

panel.addEventListener("pointermove", (e) => {
    if (!start) return;
    const offset = Math.min(sheetOffsets().peek, Math.max(0, start.offset + e.clientY - start.y));
    panel.style.transform = `translateY(${offset}px)`;
    start.speed = (e.clientY - start.last) / Math.max(1, e.timeStamp - (start.lastTime ?? start.time));
    start.last = e.clientY;
    start.lastTime = e.timeStamp;
});

const end = (e) => {
    if (!start) return;
    panel.classList.remove("dragging");
    const moved = e.clientY - start.y;
    const offsets = sheetOffsets();
    let next;
    if (Math.abs(moved) < 5) {
        next = sheet === "peek" ? "half" : "peek";
    } else if (Math.abs(start.speed ?? 0) > 0.5) {
        const i = sheets.indexOf(sheet) + (start.speed < 0 ? 1 : -1);
        next = sheets[Math.min(sheets.length - 1, Math.max(0, i))];
    } else {
        const offset = Math.min(offsets.peek, Math.max(0, start.offset + moved));
        next = sheets.reduce((a, b) => (Math.abs(offsets[b] - offset) < Math.abs(offsets[a] - offset) ? b : a));
    }
    start = null;
    setSheet(next);
};

panel.addEventListener("pointerup", end);
panel.addEventListener("pointercancel", end);
mobile.addEventListener("change", () => setSheet("peek"));
checkMissingStations();
setSheet("peek");

document.getElementById("random").addEventListener("click", () => {
    const usables = searchables.map(({ id }) => id);
    const departure = usables[Math.floor(Math.random() * usables.length)];
    const destination = usables[Math.floor(Math.random() * usables.length)];
    showRoute(departure, destination);
    if (mobile.matches) setSheet("half");
});

document.getElementById("search").addEventListener("click", () => {
    const departure = departureInput.dataset.id;
    const destination = destinationInput.dataset.id;
    if (!departure || !destination) {
        result.replaceChildren("No route found");
        return;
    }
    showRoute(departure, destination);
    if (mobile.matches) setSheet("half");
});
