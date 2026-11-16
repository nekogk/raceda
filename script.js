const city = location.pathname.split("/").filter(Boolean)[0];
const stations = await (await fetch(`/${city}/stations.json`)).json();
const lines = await (await fetch(`/${city}/lines.json`)).json();
const result = document.getElementById("result");
const departureInput = document.getElementById("departure");
const destinationInput = document.getElementById("destination");
const suggest = document.getElementById("suggest");

// ───────── 모바일 (너비 768px 이하): 아래에서 끌어올리는 패널 ─────────
// 패널은 세 높이 중 하나에 멈춘다: peek(입력칸과 버튼만), half(화면 절반), full(맨 위까지)
const panel = document.getElementById("panel");
const handle = document.getElementById("handle");
const mobile = matchMedia("(max-width: 768px)");
const SHEETS = ["peek", "half", "full"];
let sheet = "peek";

// 각 높이에서 패널을 아래로 내리는 거리(px). 클수록 패널이 많이 숨는다.
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

{
    let start = null;
    const draggable = (target) => target === handle || target === panel;
    panel.addEventListener("pointerdown", (e) => {
        if (!mobile.matches || !draggable(e.target)) return;
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
            next = sheet === "peek" ? "half" : "peek";   // 손잡이를 톡 치면 열고 닫는다
        } else if (Math.abs(start.speed ?? 0) > 0.5) {
            // 빠르게 튕기면 그 방향으로 한 칸
            const i = SHEETS.indexOf(sheet) + (start.speed < 0 ? 1 : -1);
            next = SHEETS[Math.min(SHEETS.length - 1, Math.max(0, i))];
        } else {
            // 천천히 놓으면 가장 가까운 높이로
            const offset = Math.min(offsets.peek, Math.max(0, start.offset + moved));
            next = SHEETS.reduce((a, b) => (Math.abs(offsets[b] - offset) < Math.abs(offsets[a] - offset) ? b : a));
        }
        start = null;
        setSheet(next);
    };
    panel.addEventListener("pointerup", end);
    panel.addEventListener("pointercancel", end);
    mobile.addEventListener("change", () => setSheet("peek"));
    addEventListener("resize", () => setSheet());
    setSheet("peek");
}

checkMissingStations();

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
      console.warn(`역 정보 없음: ${id} (${[...new Set(data)].join(", ")})`);
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
        console.warn(`거리 정보 없음: ${line} ${service} ${prev} → ${next}`);
        return moveCost;
    }
    if (distance <= 0) {
        console.warn(`거리가 음수임: ${line} ${service} ${prev} → ${next}`);
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

const searchables = [];
{
    const used = new Set();
    for (const { services } of Object.values(lines)) {
        for (const stops of Object.values(services)) for (const id of stops) used.add(id);
    }
    for (const id of Object.keys(stations)) {
        if (!used.has(id)) continue;
        const { st, en } = stations[id];
        const named = Boolean(st || en);
        searchables.push({ id, label: stationLabel(id), keys: named ? [st, en] : [id] });
    }
}

const SUGGEST_LIMIT = 30;
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
    const matches = [...starts, ...contains].slice(0, SUGGEST_LIMIT);

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
        if (mobile.matches) setSheet("full");   // 모바일: 자판과 검색 목록이 가리지 않게 패널을 끝까지 올린다
        openSuggest(input);
    });
    // 목록을 누르는 순간 입력칸의 blur가 먼저 일어나므로, 클릭이 처리될 틈을 두고 닫는다
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
    if (mobile.matches) setSheet("half");   // 모바일: 결과가 보이게 패널을 절반까지 올린다
});


// ───────────────────────── 노선도 ─────────────────────────
// 아래 두 함수는 노선도가 있을 때 setupMap()이 실제 동작으로 바꿔 끼운다
let highlightRoute = () => {};
let markStation = () => {};

const NS = "http://www.w3.org/2000/svg";
const ROUTE_WIDTH = 7;
const STATION_WIDTH = 15;
const TERMINAL_WIDTH = 13;
const DIM = 0.2;

const mapResponse = await fetch(`/${city}/map.svg`);
if (mapResponse.ok) setupMap(new DOMParser().parseFromString(await mapResponse.text(), "image/svg+xml").documentElement);
else document.getElementById("map").hidden = true;

function setupMap(svg) {
    const [mapX, mapY, mapW, mapH] = svg.getAttribute("viewBox").split(/[\s,]+/).map(Number);
    document.getElementById("map").append(svg);

    // ── 레이어 나누기 ──
    // map.svg의 레이어: background, line, transfer, station, etc, legend, text
    // 레이어마다 흐리는 방법이 다르다.
    //   legend                   → 통째로 흐리게
    //   background               → 위에 덮는 흰 안개(fog)로 흐리게. 경로 띠 아래는 bgFog로 따로 흐린다
    //   line, transfer, station  → 경로를 따라 그은 띠에만 구멍이 난 흰 안개(fog)를 위에 덮어서 흐리게
    //   text                     → 경로에 있는 역의 이름 상자만 남기고 흐리게
    //   etc                      → 선 조각은 routed의 맨 위로, 이름 뒤의 흰 사각형은 text의 맨 아래로 보낸다
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

    // 역 이름은 조각이 아주 많아서 레이어 전체에 mask나 opacity를 걸면 느리다.
    // 이름 하나하나(text의 자식)의 가운데 점을 구해 두고, 흐릴 때는 자식마다 따로 opacity를 준다.
    // (etc에서 옮겨 온 흰색 사각형은 넣지 않는다 → 어느 경우에도 흐려지지 않는다)
    const labels = [...textLayer.querySelectorAll(":scope > g")].map((element) => {
        const { x, y, width, height } = element.getBBox();
        return { element, x: x + width / 2, y: y + height / 2 };
    });


    // ── 승강장 좌표 모으기 ──
    const platforms = [];
    const platformsOf = new Map();
    for (const lineData of Object.values(lines)) {
        for (const [id, [x, y]] of Object.entries(lineData.positions ?? {})) {
            platforms.push([x, y, id]);
            if (!platformsOf.has(id)) platformsOf.set(id, []);
            platformsOf.get(id).push([x, y]);
        }
    }

    // 점들을 잇는 SVG 경로. [x, y, n]처럼 세 번째 값이 있는 점(bends의 모서리)에서는
    // 꺾지 않고 반지름 n의 원호로 돈다. 노선도의 곡선은 모두 반지름이 일정한 원호라서
    // 원호 하나를 "앞뒤 직선이 만나는 모서리 점 + 반지름" 하나로 나타낼 수 있다.
    // 이웃한 두 원호가 한 직선 구간을 나눠 쓰는데 길이가 모자라면 두 원호의 반지름을 같은 비율로 줄인다 (반지름은 최대 n).
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

    // 한 역의 승강장들을 잇는 모양. 가장 가까운 승강장끼리 먼저 이어 나간다.
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


    // ── 확대·이동 ──
    const view = { x: mapX, y: mapY, w: mapW };

    function applyView() {
        if (svg.clientWidth === 0) return;
        const h = view.w * svg.clientHeight / svg.clientWidth;
        svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${h}`);
    }

    // 처음에는 노선도 전체가 화면 가운데에 들어오게 맞춘다
    const ratio = svg.clientWidth / svg.clientHeight;
    view.w = Math.max(mapW, mapH * ratio);
    view.x = mapX + (mapW - view.w) / 2;
    view.y = mapY + (mapH - view.w / ratio) / 2;
    // 모바일: 아래 패널이 가리는 만큼 노선도를 위로 올려, 보이는 부분의 가운데에 오게 한다
    if (mobile.matches) view.y += (innerHeight - panel.getBoundingClientRect().top) / 2 * view.w / svg.clientWidth;
    applyView();
    new ResizeObserver(applyView).observe(svg);

    // 화면 위의 위치 → 노선도 좌표
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

    // 끌어서 옮기기(손가락 하나 / 마우스)와 두 손가락으로 벌리고 오므려 확대·축소
    const clampW = (w) => Math.min(mapW * 2, Math.max(mapW / 24, w));
    const pointers = new Map();   // 화면을 누르고 있는 손가락(포인터) → 화면 좌표
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
            pinch = { dist: m.dist, w: view.w, anchor: toMapPoint(m) };   // anchor: 두 손가락 가운데에 있던 노선도 지점
            if (drag) drag.moved = true;   // 두 손가락을 쓰면 탭(역 선택)으로 치지 않는다
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
            const now = toMapPoint(m);   // anchor가 지금 두 손가락 가운데에 오도록 옮긴다
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
        if (pointers.size === 1) {   // 두 손가락 중 하나를 떼면 남은 손가락으로 계속 끈다
            const [p] = pointers.values();
            drag = { start: toMapPoint({ clientX: p.x, clientY: p.y }), x: p.x, y: p.y, moved: true };
        }
    };
    svg.addEventListener("pointerup", release);
    svg.addEventListener("pointercancel", release);


    // ── 역 클릭 ──
    function nearestStation(p) {
        let best = null;
        // 화면에서 약 12px 안쪽 (손가락으로 누르는 기기는 22px)
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
            if (fog.style.display !== "none") {   // 경로가 떠 있으면
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

    // 출발역·도착역 표시: 그 역의 승강장들을 굵고 둥근 선으로 감싼다
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


    // ── 경로만 남기고 흐리게 ──
    // 그림 자체에는 손대지 않고, 그 위에 반투명한 흰 사각형(안개)을 덮어서 흐리게 한다.
    // 흰 바탕 위에서는 "불투명도 DIM으로 그리기"와 "흰색을 1 - DIM만큼 덮기"가 똑같아 보인다.
    // (여러 요소를 묶은 그룹에 mask를 씌우면 Safari는 요소마다 따로 흐려서, 역 점이나 환승 표시 뒤의 선이 비쳐 보인다.
    //  안개는 사각형 하나라서 어느 브라우저에서도 똑같이 그려진다.)
    // 안개의 모양은 마스크로 정한다: 흰색으로 칠한 곳에는 안개가 끼고, 검은색으로 칠한 곳은 맑다.
    // 나중에 칠한 것이 먼저 칠한 것을 덮으므로, 칠하는 순서가 곧 그림의 위아래 순서가 된다.

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

    // 노선 그림의 위아래 순서: line 레이어의 그룹 하나가 노선 하나이고, 뒤에 있는 그룹일수록 위에 그려진다.
    // 그룹마다 색이 있는 실선(노선 본체)을 찾아, 그 모양 그대로 회색 ROUTE_WIDTH 두께의 '덮개'를 만들어 둔다.
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

    // lines.json의 노선이 몇 번째 그룹인지: 색이 같은 그룹 중, 그 노선의 승강장 좌표를 가장 많이 지나는 것
    // (색이 같은 노선이 여럿 있어도 실제로 그려진 선으로 구별한다)
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

    // etc에서 온 선 조각(환승 표시 위를 지나는 다리)은 모든 것의 위에 있다
    const bridgeCovers = [...bridges.children].filter(isBody).map((element) => {
        const middle = element.getPointAtLength(element.getTotalLength() / 2);
        return { color: getComputedStyle(element).stroke, middle: [middle.x, middle.y], cover: makeCover(element) };
    });

    // 승강장 사이는 직선으로 잇되, 선이 휘는 구간은 lines.json의 bends에 적힌 모서리 [x, y, n]을 거쳐 반지름 n으로 돈다
    function edgePoints(line, a, b) {
        const lineData = lines[line];
        if (!lineData.positions?.[a] || !lineData.positions?.[b]) return [];
        const bends = lineData.bends?.[`${a}|${b}`] ?? [...(lineData.bends?.[`${b}|${a}`] ?? [])].reverse();
        return [lineData.positions[a], ...bends, lineData.positions[b]];
    }

    // a에서 b까지 실제로 지나가는 역들 (급행이 통과하는 역 포함): 둘 사이가 가장 촘촘한 계통의 목록을 쓴다
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

    // 점에서 꺾은선까지의 거리
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

    // fog: line·transfer·station 위에 덮는 안개 (경로 띠만 맑다)
    // bgFog: background 위, 노선 아래에 덮는 안개 (경로 띠에만 낀다). 띠 밖의 background는 fog가 흐린다.
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

    // 종점: 한 노선에서 어떤 계통의 처음이나 마지막에 오고, 어느 계통에서도 중간에 오지 않는 역
    // (급행이 중간역에서 출발하거나 끝나는 경우는 종점이 아니다. 순환선은 종점이 없다)
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

        // 노선별로, 그 노선을 타고 가는 구간들의 모양을 모은다
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
        // 경로 띠와 역 모양: fog에는 검은색(맑게), bgFog에는 흰색(안개)으로 같은 모양을 칠한다
        const clear = [];
        const addClear = (d, width) => {
            clear.push([d, width]);
            return makeStroke(d, "black", width);
        };
        const strokesOf = (line) => rides.get(line).map((points) => addClear(pathOf(points), ROUTE_WIDTH));

        // fog: 전체를 흰색(안개)으로 깔고, 아래에 있는 노선부터 차례로 칠한다.
        //   모든 노선  → 흰색 덮개 (ROUTE_WIDTH)
        //   타는 노선  → 그 위에 경로 구간을 검은색 띠로 (ROUTE_WIDTH)
        // 이렇게 하면 경로보다 위에 그려진 다른 노선은 띠 위에 안개로 남아서, 겹치는 곳에서 경로를 덮은 채로 흐려진다.
        fogMask.replaceChildren(makeRect(mapX, mapY, mapW, mapH, "white"));
        lineGroups.forEach((group, i) => {
            fogMask.append(...group.covers);
            for (const line of rides.keys()) if (groupOf[line] === i) fogMask.append(...strokesOf(line));
        });
        for (const line of rides.keys()) if (groupOf[line] < 0) fogMask.append(...strokesOf(line));

        // 다리 조각: 같은 색 노선의 경로가 그 자리를 지나가면 그대로 두고, 아니면 회색으로 덮는다
        for (const bridge of bridgeCovers) {
            const used = [...rides].some(([line, list]) =>
                toRgb(lines[line].color) === bridge.color && list.some((points) => distanceTo(points, bridge.middle) < 3));
            if (!used) fogMask.append(bridge.cover);
        }

        // 경로가 서거나 통과하는 환승역(승강장이 둘 이상인 역)은 환승 표시 전체를 남기고,
        // 환승역이 아닌 종점은 그 점을 중심으로 지름 TERMINAL_WIDTH의 원을 남긴다
        for (const station of passedStations) {
            const count = platformsOf.get(station)?.length ?? 0;
            if (count > 1) {
                fogMask.append(addClear(stationShape(station), STATION_WIDTH));
            } else if (count === 1 && terminals.has(station)) {
                fogMask.append(addClear(stationShape(station), TERMINAL_WIDTH));
            }
        }

        // bgFog: 맑게 남긴 모양 그대로, 그 아래의 background만 흐린다
        bgFogMask.replaceChildren(...clear.map(([d, width]) => makeStroke(d, "white", width)));
        fog.style.display = bgFog.style.display = "";

        // legend: 통째로 흐리게
        legend.style.opacity = DIM;

        // text: 경로에 있는 역의 이름 상자 안에 있는 이름만 남기고 흐리게
        const boxes = path.map(([station]) => stations[station]?.box).filter(Boolean);
        for (const { element, x, y } of labels) {
            const lit = boxes.some(([x1, y1, x2, y2]) => x1 <= x && x <= x2 && y1 <= y && y <= y2);
            element.style.opacity = lit ? "" : DIM;
        }
    };
}
