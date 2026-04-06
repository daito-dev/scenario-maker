// ============================================================
//  Types
// ============================================================

interface Point {
  x: number;
  y: number;
}

interface Waypoint {
  x: number;
  offset: number;
}

interface BrakePoint {
  x: number;
  decelerationMps2: number;
}

interface Vehicle {
  id: string;
  label: string;
  color: string;
  enabled: boolean;
  lane: number;
  waypoints: Waypoint[];
  smoothness: number;
  speedKmh: number;
  brakePoints: BrakePoint[];
}

interface DragState {
  vehicleIndex: number;
  waypointIndex: number;
  isBrakePoint?: boolean;
  brakePointIndex?: number;
}

interface VehiclePanelElements {
  enabled: HTMLInputElement | null;
  lane: HTMLInputElement | null;
  color: HTMLInputElement | null;
  speed: HTMLInputElement | null;
  waypoints: HTMLTextAreaElement | null;
  addWaypoint: HTMLButtonElement | null;
  brakePoints: HTMLTextAreaElement | null;
  addBrakePoint: HTMLButtonElement | null;
  smooth: HTMLInputElement | null;
  smoothValue: HTMLSpanElement | null;
}

// ============================================================
//  Constants
// ============================================================

const MARGIN_LEFT = 60;
const MARGIN_RIGHT = 20;
const LANE_HEIGHT = 80;
const HIT_RADIUS = 10;
const MAX_WAYPOINTS = 10;
const MAX_BRAKE_POINTS = 10;
const TIME_STEP_SEC = 0.5;
const WAYPOINT_RADIUS = 6;
const WAYPOINT_OUTLINE_RADIUS = 8;
const TIME_DOT_RADIUS = 3;
const DEFAULT_DECELERATION = 3.0;
const CANVAS_MIN_WIDTH = 400;
const CANVAS_MIN_HEIGHT = 200;
const CANVAS_PADDING = 40;
const LINEAR_STEPS_PER_SEGMENT = 20;
const BEZIER_STEPS_PER_SEGMENT = 24;
const BRAKE_TRIANGLE_HEIGHT = 10;
const BRAKE_TRIANGLE_HALF_WIDTH = 6;
const BRAKE_TRIANGLE_TOP_OFFSET = 20;

const VEHICLE_DISPLAY_NAMES: Record<string, string> = {
  ego: "Ego Vehicle",
  npc1: "NPC 1",
  npc2: "NPC 2",
  npc3: "NPC 3",
};

const MODAL_FIELD_IDS = [
  "road-width",
  "cam-loc-x", "cam-loc-y", "cam-loc-z",
  "cam-bank", "cam-tilt", "cam-heading",
  "cam-length", "cam-width", "cam-height",
  "cam-hres", "cam-vres", "cam-fps", "cam-focal",
  "cam-ccd",
  "cam-fov-az", "cam-fov-el",
  "cam-near", "cam-far",
];

// ============================================================
//  DOM References
// ============================================================

const canvas = document.getElementById("scenarioCanvas") as HTMLCanvasElement;

function getContext2D(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = c.getContext("2d");
  if (!context) throw new Error("Failed to get 2D rendering context");
  return context;
}

const ctx = getContext2D(canvas);
const lanesInput = document.getElementById("lanesInput") as HTMLInputElement;
const distanceInput = document.getElementById("distanceInput") as HTMLInputElement;
const resetButton = document.getElementById("resetButton") as HTMLButtonElement;
const modalOpenButton = document.getElementById("openCameraDialog")!;
const modal = document.getElementById("cameraModal")!;
const modalOkButton = document.getElementById("cameraModalOk")!;
const modalCancelButton = document.getElementById("cameraModalCancel")!;

// ============================================================
//  State
// ============================================================

let lanesPerSide = clamp(parseInt(lanesInput.value, 10) || 2, 1, 6);
let totalDistanceM = parseInt(distanceInput.value, 10) || 500;
let dragState: DragState | null = null;
let dragRafPending = false;
let modalSnapshot: Record<string, string> = {};

const vehicles: Vehicle[] = createInitialVehicles();

// ============================================================
//  Utilities
// ============================================================

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundTo2(value: number): number {
  return Math.round(value * 100) / 100;
}

function getDrawableWidth(canvasWidth: number): number {
  return canvasWidth - MARGIN_LEFT - MARGIN_RIGHT;
}

function offsetLimit(): number {
  return lanesPerSide * 1.5;
}

function kmhToMps(kmh: number): number {
  return kmh / 3.6;
}

function computeLaneLayout(canvasHeight: number): { top: number; bottom: number } {
  const totalHeight = LANE_HEIGHT * lanesPerSide;
  const top = (canvasHeight - totalHeight) / 2;
  return { top, bottom: top + totalHeight };
}

function laneCenterY(canvasHeight: number, lane: number): number {
  const { bottom } = computeLaneLayout(canvasHeight);
  return bottom - (lane - 0.5) * LANE_HEIGHT;
}

function distanceGridStep(): number {
  if (totalDistanceM <= 500) return 50;
  if (totalDistanceM <= 1000) return 100;
  if (totalDistanceM <= 2000) return 200;
  return 500;
}

// ============================================================
//  Initial Vehicle Data
// ============================================================

function createInitialVehicles(): Vehicle[] {
  return [
    {
      id: "ego", label: "Ego", color: "#ff4444",
      enabled: true, lane: 1, smoothness: 0.7, speedKmh: 72,
      waypoints: [{ x: 0, offset: 0 }, { x: 0.5, offset: 0 }, { x: 1, offset: 0 }],
      brakePoints: [],
    },
    {
      id: "npc1", label: "NPC 1", color: "#337bff",
      enabled: true, lane: 2, smoothness: 0.2, speedKmh: 54,
      waypoints: [{ x: 0, offset: 0 }, { x: 0.5, offset: 0 }, { x: 1, offset: 0 }],
      brakePoints: [],
    },
    {
      id: "npc2", label: "NPC 2", color: "#2ecc71",
      enabled: false, lane: 1, smoothness: 0.7, speedKmh: 72,
      waypoints: [], brakePoints: [],
    },
    {
      id: "npc3", label: "NPC 3", color: "#f39c12",
      enabled: false, lane: 2, smoothness: 0.7, speedKmh: 72,
      waypoints: [], brakePoints: [],
    },
  ];
}

// ============================================================
//  CSV Parsing / Serialization
// ============================================================

function parseCsvLines(text: string): [number, number][] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .reduce<[number, number][]>((result, line) => {
      const parts = line.split(",");
      if (parts.length < 2) return result;

      const a = parseFloat(parts[0]);
      const b = parseFloat(parts[1]);
      if (isNaN(a) || isNaN(b)) return result;
      if (a < 0 || a > 1) return result;

      result.push([roundTo2(a), roundTo2(b)]);
      return result;
    }, []);
}

function parseWaypoints(text: string): Waypoint[] {
  return parseCsvLines(text)
    .map(([x, offset]) => ({ x, offset }))
    .sort((a, b) => a.x - b.x);
}

function parseBrakePoints(text: string): BrakePoint[] {
  return parseCsvLines(text)
    .map(([x, decelerationMps2]) => ({ x, decelerationMps2 }))
    .sort((a, b) => a.x - b.x);
}

function waypointsToText(waypoints: Waypoint[]): string {
  return [...waypoints]
    .sort((a, b) => a.x - b.x)
    .map((wp) => `${wp.x.toFixed(2)},${wp.offset.toFixed(2)}`)
    .join("\n");
}

function brakePointsToText(brakePoints: BrakePoint[]): string {
  return [...brakePoints]
    .sort((a, b) => a.x - b.x)
    .map((bp) => `${bp.x.toFixed(2)},${bp.decelerationMps2.toFixed(2)}`)
    .join("\n");
}

// ============================================================
//  Coordinate Conversion
// ============================================================

function waypointToCanvas(vehicle: Vehicle, wp: Waypoint, canvasWidth: number, canvasHeight: number): Point {
  const baseY = laneCenterY(canvasHeight, vehicle.lane);
  const lateralScale = LANE_HEIGHT * 0.5;
  const drawableWidth = getDrawableWidth(canvasWidth);

  return {
    x: MARGIN_LEFT + clamp(wp.x, 0, 1) * drawableWidth,
    y: baseY - wp.offset * lateralScale,
  };
}

function interpolateYOnPath(pathSamples: Point[], targetX: number): number {
  let index = 0;
  while (index < pathSamples.length - 1 && pathSamples[index + 1].x < targetX) {
    index++;
  }

  const pointA = pathSamples[index];
  const pointB = pathSamples[Math.min(index + 1, pathSamples.length - 1)];
  const dx = pointB.x - pointA.x || 1;
  const alpha = clamp((targetX - pointA.x) / dx, 0, 1);

  return pointA.y + (pointB.y - pointA.y) * alpha;
}

// ============================================================
//  Bézier Path Computation
// ============================================================

function cubicBezierPoint(p0: Point, c1: Point, c2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const uu = u * u;
  const uuu = uu * u;
  const tt = t * t;
  const ttt = tt * t;

  return {
    x: uuu * p0.x + 3 * uu * t * c1.x + 3 * u * tt * c2.x + ttt * p3.x,
    y: uuu * p0.y + 3 * uu * t * c1.y + 3 * u * tt * c2.y + ttt * p3.y,
  };
}

function computeTangentDirection(from: Point, to: Point): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  return { x: dx / length, y: dy / length };
}

function computePathSamples(vehicle: Vehicle, canvasWidth: number, canvasHeight: number): Point[] {
  const sortedWaypoints = [...vehicle.waypoints].sort((a, b) => a.x - b.x);
  if (sortedWaypoints.length === 0) return [];

  const points = sortedWaypoints.map((wp) => waypointToCanvas(vehicle, wp, canvasWidth, canvasHeight));

  if (points.length === 1) {
    return [{ x: points[0].x, y: points[0].y }];
  }

  if (vehicle.smoothness <= 0.01 || points.length === 2) {
    return computeLinearSamples(points);
  }

  return computeBezierSamples(points, vehicle.smoothness);
}

function computeLinearSamples(points: Point[]): Point[] {
  const samples: Point[] = [{ x: points[0].x, y: points[0].y }];

  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i];
    const end = points[i + 1];

    for (let step = 1; step <= LINEAR_STEPS_PER_SEGMENT; step++) {
      const t = step / LINEAR_STEPS_PER_SEGMENT;
      samples.push({
        x: start.x + (end.x - start.x) * t,
        y: start.y + (end.y - start.y) * t,
      });
    }
  }

  return samples;
}

function computeBezierSamples(points: Point[], smoothness: number): Point[] {
  const samples: Point[] = [{ x: points[0].x, y: points[0].y }];
  const tangentFactor = 0.35 * smoothness;

  for (let i = 0; i < points.length - 1; i++) {
    const segStart = points[i];
    const segEnd = points[i + 1];
    const segLength = Math.hypot(segEnd.x - segStart.x, segEnd.y - segStart.y);

    if (segLength < 1e-3) {
      samples.push({ x: segEnd.x, y: segEnd.y });
      continue;
    }

    const prevTangent = i === 0
      ? computeTangentDirection(segStart, segEnd)
      : computeTangentDirection(points[i - 1], segStart);

    const nextTangent = i + 2 >= points.length
      ? computeTangentDirection(segStart, segEnd)
      : computeTangentDirection(segEnd, points[i + 2]);

    const handleLength = segLength * tangentFactor;
    const controlPoint1: Point = {
      x: segStart.x + prevTangent.x * handleLength,
      y: segStart.y + prevTangent.y * handleLength,
    };
    const controlPoint2: Point = {
      x: segEnd.x - nextTangent.x * handleLength,
      y: segEnd.y - nextTangent.y * handleLength,
    };

    for (let step = 1; step <= BEZIER_STEPS_PER_SEGMENT; step++) {
      const t = step / BEZIER_STEPS_PER_SEGMENT;
      samples.push(cubicBezierPoint(segStart, controlPoint1, controlPoint2, segEnd, t));
    }
  }

  return samples;
}

// ============================================================
//  Drawing: Sub-functions
// ============================================================

function drawBackground(canvasWidth: number, canvasHeight: number): void {
  ctx.fillStyle = "#1f2933";
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);
}

function drawDistanceGrid(canvasWidth: number, canvasHeight: number): void {
  const drawableWidth = getDrawableWidth(canvasWidth);
  const stepM = distanceGridStep();
  const stepCount = totalDistanceM / stepM;

  ctx.lineWidth = 1;

  for (let i = 0; i <= stepCount; i++) {
    const ratio = i / stepCount;
    const xPix = MARGIN_LEFT + ratio * drawableWidth;

    ctx.save();
    ctx.setLineDash([4, 8]);
    ctx.strokeStyle = "#374151";
    ctx.beginPath();
    ctx.moveTo(xPix, 0);
    ctx.lineTo(xPix, canvasHeight);
    ctx.stroke();
    ctx.restore();

    const tickY = canvasHeight - 4;
    ctx.strokeStyle = "#9ca3af";
    ctx.beginPath();
    ctx.moveTo(xPix, tickY);
    ctx.lineTo(xPix, canvasHeight);
    ctx.stroke();

    ctx.fillStyle = "#9ca3af";
    ctx.font = "10px 'Times New Roman', serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(`${i * stepM}m`, xPix, tickY - 2);
  }

  ctx.strokeStyle = "#9ca3af";
  ctx.beginPath();
  ctx.moveTo(MARGIN_LEFT, canvasHeight);
  ctx.lineTo(MARGIN_LEFT + drawableWidth, canvasHeight);
  ctx.stroke();
}

function drawLanes(canvasWidth: number, canvasHeight: number): void {
  const drawableWidth = getDrawableWidth(canvasWidth);
  const { top, bottom } = computeLaneLayout(canvasHeight);

  ctx.strokeStyle = "#4b5563";
  ctx.lineWidth = 1;
  for (let i = 0; i <= lanesPerSide; i++) {
    const y = top + i * LANE_HEIGHT;
    ctx.beginPath();
    ctx.moveTo(MARGIN_LEFT, y);
    ctx.lineTo(MARGIN_LEFT + drawableWidth, y);
    ctx.stroke();
  }

  ctx.fillStyle = "#9ca3af";
  ctx.font = "12px 'Times New Roman', serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (let lane = 1; lane <= lanesPerSide; lane++) {
    const centerY = bottom - (lane - 0.5) * LANE_HEIGHT;
    ctx.fillText(`Lane ${lane}`, 8, centerY);
  }
}

function drawTrajectoryPath(pathSamples: Point[], color: string): void {
  if (pathSamples.length < 2) return;

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(pathSamples[0].x, pathSamples[0].y);
  for (let i = 1; i < pathSamples.length; i++) {
    ctx.lineTo(pathSamples[i].x, pathSamples[i].y);
  }
  ctx.stroke();
}

function drawWaypointMarkers(vehicle: Vehicle, canvasWidth: number, canvasHeight: number): void {
  const sortedWaypoints = [...vehicle.waypoints].sort((a, b) => a.x - b.x);

  sortedWaypoints.forEach((wp, index) => {
    const pos = waypointToCanvas(vehicle, wp, canvasWidth, canvasHeight);

    ctx.beginPath();
    ctx.fillStyle = vehicle.color;
    ctx.arc(pos.x, pos.y, WAYPOINT_RADIUS, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.strokeStyle = "#ffffffaa";
    ctx.lineWidth = 1;
    ctx.arc(pos.x, pos.y, WAYPOINT_OUTLINE_RADIUS, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = "#e5e7eb";
    ctx.font = "10px 'Times New Roman', serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(index), pos.x, pos.y - 12);
  });
}

function drawBrakePointMarkers(vehicle: Vehicle, pathSamples: Point[], canvasWidth: number, canvasHeight: number): void {
  if (vehicle.id !== "ego" || vehicle.brakePoints.length === 0) return;

  const drawableWidth = getDrawableWidth(canvasWidth);

  vehicle.brakePoints.forEach((bp) => {
    const xPix = MARGIN_LEFT + bp.x * drawableWidth;
    let yPix = canvasHeight / 2;

    if (pathSamples.length >= 2) {
      yPix = interpolateYOnPath(pathSamples, xPix);
    }

    ctx.beginPath();
    ctx.fillStyle = "#ffaa00";
    ctx.moveTo(xPix, yPix - BRAKE_TRIANGLE_HEIGHT);
    ctx.lineTo(xPix - BRAKE_TRIANGLE_HALF_WIDTH, yPix - BRAKE_TRIANGLE_TOP_OFFSET);
    ctx.lineTo(xPix + BRAKE_TRIANGLE_HALF_WIDTH, yPix - BRAKE_TRIANGLE_TOP_OFFSET);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = "#ffffff";
    ctx.font = "9px 'Times New Roman', serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(`${bp.decelerationMps2.toFixed(1)}m/s²`, xPix, yPix - BRAKE_TRIANGLE_TOP_OFFSET - 2);
  });
}

function drawTimeDots(vehicle: Vehicle, pathSamples: Point[], canvasWidth: number): void {
  const sortedWaypoints = [...vehicle.waypoints].sort((a, b) => a.x - b.x);

  let points: Point[];
  if (pathSamples.length >= 2) {
    points = pathSamples;
  } else if (sortedWaypoints.length > 0) {
    points = sortedWaypoints.map((wp) => waypointToCanvas(vehicle, wp, canvasWidth, canvas.height));
  } else {
    points = [];
  }

  if (points.length < 2) return;

  const startXPix = points[0].x;
  const maxXPix = points[points.length - 1].x;

  const initialSpeedMps = Math.max(0, kmhToMps(vehicle.speedKmh));
  if (initialSpeedMps <= 0) return;

  const firstWpX = sortedWaypoints[0].x;
  const lastWpX = sortedWaypoints[sortedWaypoints.length - 1].x;
  const trajectoryDistanceM = (lastWpX - firstWpX) * totalDistanceM;
  const drawableWidth = getDrawableWidth(canvasWidth);
  const pixelsPerMeter = drawableWidth / totalDistanceM;

  const brakesInMeters = [...vehicle.brakePoints]
    .map((bp) => ({ distM: (bp.x - firstWpX) * totalDistanceM, decel: bp.decelerationMps2 }))
    .filter((b) => b.distM >= 0 && b.distM <= trajectoryDistanceM)
    .sort((a, b) => a.distM - b.distM);

  let currentSpeed = initialSpeedMps;
  let traveledDistM = 0;

  while (traveledDistM <= trajectoryDistanceM + 1e-6) {
    const targetX = startXPix + traveledDistM * pixelsPerMeter;
    if (targetX > maxXPix) break;

    const yPix = interpolateYOnPath(points, targetX);

    ctx.beginPath();
    ctx.fillStyle = vehicle.color;
    ctx.arc(targetX, yPix, TIME_DOT_RADIUS, 0, Math.PI * 2);
    ctx.fill();

    let activeDecel = 0;
    for (const brake of brakesInMeters) {
      if (traveledDistM >= brake.distM) {
        activeDecel = brake.decel;
      }
    }

    if (activeDecel > 0) {
      currentSpeed = Math.max(0, currentSpeed - activeDecel * TIME_STEP_SEC);
    }
    if (currentSpeed <= 0) break;

    traveledDistM += currentSpeed * TIME_STEP_SEC;
  }
}

// ============================================================
//  Drawing: Main
// ============================================================

function draw(): void {
  const canvasWidth = canvas.width;
  const canvasHeight = canvas.height;

  ctx.clearRect(0, 0, canvasWidth, canvasHeight);

  drawBackground(canvasWidth, canvasHeight);
  drawDistanceGrid(canvasWidth, canvasHeight);
  drawLanes(canvasWidth, canvasHeight);

  for (const vehicle of vehicles) {
    if (!vehicle.enabled || vehicle.waypoints.length === 0) continue;

    const pathSamples = computePathSamples(vehicle, canvasWidth, canvasHeight);

    drawTrajectoryPath(pathSamples, vehicle.color);
    drawWaypointMarkers(vehicle, canvasWidth, canvasHeight);
    drawBrakePointMarkers(vehicle, pathSamples, canvasWidth, canvasHeight);
    drawTimeDots(vehicle, pathSamples, canvasWidth);
  }
}

// ============================================================
//  Advanced Settings Modal
// ============================================================

function saveModalSnapshot(): void {
  modalSnapshot = {};
  for (const id of MODAL_FIELD_IDS) {
    const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
    if (el) modalSnapshot[id] = el.value;
  }
}

function restoreModalSnapshot(): void {
  for (const id of MODAL_FIELD_IDS) {
    const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
    if (el && id in modalSnapshot) el.value = modalSnapshot[id];
  }
}

function openModal(): void {
  saveModalSnapshot();
  modal.classList.add("show");
}

function closeModalWithSave(): void {
  modal.classList.remove("show");
}

function closeModalWithCancel(): void {
  restoreModalSnapshot();
  modal.classList.remove("show");
}

function setupModal(): void {
  modalOpenButton.onclick = openModal;
  modalCancelButton.onclick = closeModalWithCancel;
  modalOkButton.onclick = closeModalWithSave;
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeModalWithCancel();
  });
}

// ============================================================
//  Vehicle Panel Generation
// ============================================================

function createVehiclePanelHTML(vehicle: Vehicle): string {
  const displayName = VEHICLE_DISPLAY_NAMES[vehicle.id] ?? vehicle.id;
  const checkedAttr = vehicle.enabled ? "checked" : "";
  const isEgo = vehicle.id === "ego";

  let brakeSection = "";
  if (isEgo) {
    brakeSection = `
      <label>Brake Points (x, decel [m/s&sup2;]):</label>
      <textarea class="vehicle-brakepoints"></textarea>
      <button class="vehicle-add-bp">Add Brake Point</button>`;
  }

  return `
    <div class="vehicle-panel" data-vehicle-id="${vehicle.id}">
      <div class="vehicle-header">
        <span class="vehicle-label">${displayName}</span>
        <label><input type="checkbox" class="vehicle-enabled" ${checkedAttr} /> Show</label>
      </div>
      <div class="vehicle-body">
        <label>Initial Lane:
          <input type="number" class="vehicle-lane" min="1" max="6" value="${vehicle.lane}" />
        </label>
        <label>
          Color:
          <input type="color" class="vehicle-color" value="${vehicle.color}" />
          Speed (km/h):
          <input type="number" class="vehicle-speed" step="1" value="${vehicle.speedKmh}" />
        </label>
        <label>Curve Smoothness:
          <input type="range" class="vehicle-smooth" min="0" max="1" step="0.1" value="${vehicle.smoothness}" />
          <span class="vehicle-smooth-value">${vehicle.smoothness.toFixed(1)}</span>
        </label>
        <label>Waypoints:</label>
        <textarea class="vehicle-waypoints"></textarea>
        <button class="vehicle-add-wp">Add Waypoint</button>
        ${brakeSection}
      </div>
    </div>`;
}

function generateVehiclePanels(): void {
  const container = document.getElementById("vehiclePanelsContainer");
  if (!container) return;

  container.innerHTML = vehicles.map(createVehiclePanelHTML).join("");
}

// ============================================================
//  Vehicle Panel DOM Helpers
// ============================================================

function findPanelElements(panel: HTMLDivElement): VehiclePanelElements {
  return {
    enabled: panel.querySelector<HTMLInputElement>(".vehicle-enabled"),
    lane: panel.querySelector<HTMLInputElement>(".vehicle-lane"),
    color: panel.querySelector<HTMLInputElement>(".vehicle-color"),
    speed: panel.querySelector<HTMLInputElement>(".vehicle-speed"),
    waypoints: panel.querySelector<HTMLTextAreaElement>(".vehicle-waypoints"),
    addWaypoint: panel.querySelector<HTMLButtonElement>(".vehicle-add-wp"),
    brakePoints: panel.querySelector<HTMLTextAreaElement>(".vehicle-brakepoints"),
    addBrakePoint: panel.querySelector<HTMLButtonElement>(".vehicle-add-bp"),
    smooth: panel.querySelector<HTMLInputElement>(".vehicle-smooth"),
    smoothValue: panel.querySelector<HTMLSpanElement>(".vehicle-smooth-value"),
  };
}

function syncPanelFromVehicle(panel: HTMLDivElement, vehicle: Vehicle): void {
  const el = findPanelElements(panel);

  if (el.enabled) el.enabled.checked = vehicle.enabled;
  if (el.lane) el.lane.value = String(vehicle.lane);
  if (el.color) el.color.value = vehicle.color;
  if (el.speed) el.speed.value = String(vehicle.speedKmh);
  if (el.waypoints) el.waypoints.value = waypointsToText(vehicle.waypoints);
  if (el.brakePoints) el.brakePoints.value = brakePointsToText(vehicle.brakePoints);
  if (el.smooth && el.smoothValue) {
    el.smooth.value = String(vehicle.smoothness);
    el.smoothValue.textContent = vehicle.smoothness.toFixed(1);
  }
}

// ============================================================
//  UI Setup
// ============================================================

function setupLanesInput(): void {
  lanesInput.addEventListener("input", () => {
    const parsed = parseInt(lanesInput.value, 10);
    if (isNaN(parsed)) return;

    lanesPerSide = clamp(parsed, 1, 6);
    lanesInput.value = String(lanesPerSide);

    for (const vehicle of vehicles) {
      vehicle.lane = clamp(vehicle.lane, 1, lanesPerSide);
    }

    syncUIFromState();
    draw();
  });
}

function setupDistanceInput(): void {
  distanceInput.addEventListener("input", () => {
    const parsed = parseInt(distanceInput.value, 10);
    if (isNaN(parsed) || parsed <= 0) return;

    totalDistanceM = clamp(parsed, 100, 5000);
    distanceInput.value = String(totalDistanceM);
    draw();
  });
}

function setupVehiclePanel(panel: HTMLDivElement, vehicle: Vehicle): void {
  const el = findPanelElements(panel);

  if (el.enabled) {
    el.enabled.checked = vehicle.enabled;
    el.enabled.addEventListener("change", () => {
      vehicle.enabled = el.enabled!.checked;
      draw();
    });
  }

  if (el.lane) {
    el.lane.value = String(vehicle.lane);
    el.lane.addEventListener("input", () => {
      const parsed = parseInt(el.lane!.value, 10);
      if (isNaN(parsed)) return;
      vehicle.lane = clamp(parsed, 1, lanesPerSide);
      el.lane!.value = String(vehicle.lane);
      draw();
    });
  }

  if (el.color) {
    el.color.value = vehicle.color;
    el.color.addEventListener("input", () => {
      vehicle.color = el.color!.value;
      draw();
    });
  }

  if (el.speed) {
    el.speed.value = String(vehicle.speedKmh);
    el.speed.addEventListener("input", () => {
      const parsed = parseFloat(el.speed!.value);
      if (isNaN(parsed) || parsed < 0) return;
      vehicle.speedKmh = parsed;
      draw();
    });
  }

  if (el.waypoints) {
    el.waypoints.value = waypointsToText(vehicle.waypoints);
    el.waypoints.addEventListener("input", () => {
      vehicle.waypoints = parseWaypoints(el.waypoints!.value).slice(0, MAX_WAYPOINTS);
      draw();
    });
  }

  if (el.addWaypoint) {
    el.addWaypoint.addEventListener("click", () => {
      if (vehicle.waypoints.length >= MAX_WAYPOINTS) return;

      let newX = 0.5;
      if (vehicle.waypoints.length > 0) {
        newX = clamp(vehicle.waypoints[vehicle.waypoints.length - 1].x + 0.1, 0, 1);
      }

      vehicle.waypoints.push({ x: newX, offset: 0 });
      syncUIFromState();
      draw();
    });
  }

  if (el.brakePoints && vehicle.id === "ego") {
    el.brakePoints.value = brakePointsToText(vehicle.brakePoints);
    el.brakePoints.addEventListener("input", () => {
      vehicle.brakePoints = parseBrakePoints(el.brakePoints!.value).slice(0, MAX_BRAKE_POINTS);
      draw();
    });
  }

  if (el.addBrakePoint && vehicle.id === "ego") {
    el.addBrakePoint.addEventListener("click", () => {
      if (vehicle.brakePoints.length >= MAX_BRAKE_POINTS) return;

      let newX = 0.5;
      if (vehicle.brakePoints.length > 0) {
        newX = clamp(vehicle.brakePoints[vehicle.brakePoints.length - 1].x + 0.1, 0, 1);
      }

      vehicle.brakePoints.push({ x: newX, decelerationMps2: DEFAULT_DECELERATION });
      syncUIFromState();
      draw();
    });
  }

  if (el.smooth && el.smoothValue) {
    el.smooth.value = String(vehicle.smoothness);
    el.smoothValue.textContent = vehicle.smoothness.toFixed(1);
    el.smooth.addEventListener("input", () => {
      const parsed = parseFloat(el.smooth!.value);
      if (isNaN(parsed)) return;
      vehicle.smoothness = clamp(parsed, 0, 1);
      el.smoothValue!.textContent = vehicle.smoothness.toFixed(1);
      draw();
    });
  }
}

function setupVehiclePanels(): void {
  const panels = document.querySelectorAll<HTMLDivElement>(".vehicle-panel");

  panels.forEach((panel) => {
    const vehicleId = panel.dataset["vehicleId"];
    if (!vehicleId) return;

    const vehicle = vehicles.find((v) => v.id === vehicleId);
    if (!vehicle) return;

    setupVehiclePanel(panel, vehicle);
  });
}

function setupResetButton(): void {
  resetButton.addEventListener("click", () => {
    lanesPerSide = 2;
    totalDistanceM = 500;

    const defaults = createInitialVehicles();
    for (let i = 0; i < vehicles.length; i++) {
      Object.assign(vehicles[i], defaults[i]);
    }

    syncUIFromState();
    draw();
  });
}

function resizeCanvas(): void {
  const container = document.getElementById("canvasContainer");
  if (!container) return;

  const rect = container.getBoundingClientRect();
  canvas.width = Math.max(CANVAS_MIN_WIDTH, rect.width - CANVAS_PADDING);
  canvas.height = Math.max(CANVAS_MIN_HEIGHT, rect.height - CANVAS_PADDING);

  draw();
}

function syncUIFromState(): void {
  lanesInput.value = String(lanesPerSide);
  distanceInput.value = String(totalDistanceM);

  const panels = document.querySelectorAll<HTMLDivElement>(".vehicle-panel");
  panels.forEach((panel) => {
    const vehicleId = panel.dataset["vehicleId"];
    if (!vehicleId) return;

    const vehicle = vehicles.find((v) => v.id === vehicleId);
    if (!vehicle) return;

    syncPanelFromVehicle(panel, vehicle);
  });
}

function setupUI(): void {
  generateVehiclePanels();
  setupLanesInput();
  setupDistanceInput();
  setupVehiclePanels();
  setupResetButton();

  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);

  canvas.addEventListener("mousedown", onCanvasMouseDown);
  window.addEventListener("mousemove", onCanvasMouseMove);
  window.addEventListener("mouseup", onCanvasMouseUp);
}

// ============================================================
//  Mouse Interaction (Drag & Drop)
// ============================================================

function getCanvasCoords(event: MouseEvent): Point | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;

  return {
    x: (event.clientX - rect.left) * (canvas.width / rect.width),
    y: (event.clientY - rect.top) * (canvas.height / rect.height),
  };
}

function pixelXToNormalized(pixelX: number, canvasWidth: number): number {
  return clamp((pixelX - MARGIN_LEFT) / getDrawableWidth(canvasWidth), 0, 1);
}

function findBrakePointAtPosition(pos: Point, canvasWidth: number, canvasHeight: number): DragState | null {
  for (let vi = 0; vi < vehicles.length; vi++) {
    const vehicle = vehicles[vi];
    if (!vehicle.enabled || vehicle.id !== "ego" || vehicle.brakePoints.length === 0) continue;

    const pathSamples = computePathSamples(vehicle, canvasWidth, canvasHeight);
    const drawableWidth = getDrawableWidth(canvasWidth);

    for (let bi = 0; bi < vehicle.brakePoints.length; bi++) {
      const xPix = MARGIN_LEFT + vehicle.brakePoints[bi].x * drawableWidth;

      let yPix = canvasHeight / 2;
      if (pathSamples.length >= 2) {
        yPix = interpolateYOnPath(pathSamples, xPix);
      }

      const markerCenterY = yPix - (BRAKE_TRIANGLE_HEIGHT + BRAKE_TRIANGLE_TOP_OFFSET) / 2;
      const dx = xPix - pos.x;
      const dy = markerCenterY - pos.y;
      if (dx * dx + dy * dy <= HIT_RADIUS * HIT_RADIUS) {
        return { vehicleIndex: vi, waypointIndex: 0, isBrakePoint: true, brakePointIndex: bi };
      }
    }
  }

  return null;
}

function findWaypointAtPosition(pos: Point, canvasWidth: number, canvasHeight: number): DragState | null {
  for (let vi = 0; vi < vehicles.length; vi++) {
    const vehicle = vehicles[vi];
    if (!vehicle.enabled) continue;

    for (let wi = 0; wi < vehicle.waypoints.length; wi++) {
      const point = waypointToCanvas(vehicle, vehicle.waypoints[wi], canvasWidth, canvasHeight);
      const dx = point.x - pos.x;
      const dy = point.y - pos.y;

      if (dx * dx + dy * dy <= HIT_RADIUS * HIT_RADIUS) {
        return { vehicleIndex: vi, waypointIndex: wi };
      }
    }
  }

  return null;
}

function onCanvasMouseDown(event: MouseEvent): void {
  const pos = getCanvasCoords(event);
  if (!pos) return;

  const canvasWidth = canvas.width;
  const canvasHeight = canvas.height;

  dragState =
    findBrakePointAtPosition(pos, canvasWidth, canvasHeight) ??
    findWaypointAtPosition(pos, canvasWidth, canvasHeight) ??
    null;
}

function applyDrag(pos: Point): void {
  if (!dragState) return;

  const vehicle = vehicles[dragState.vehicleIndex];
  const canvasWidth = canvas.width;

  if (dragState.isBrakePoint && dragState.brakePointIndex !== undefined) {
    const bp = vehicle.brakePoints[dragState.brakePointIndex];
    bp.x = roundTo2(pixelXToNormalized(pos.x, canvasWidth));
    syncUIFromState();
    draw();
    return;
  }

  const canvasHeight = canvas.height;
  const wp = vehicle.waypoints[dragState.waypointIndex];
  const baseY = laneCenterY(canvasHeight, vehicle.lane);
  const lateralScale = LANE_HEIGHT * 0.5;

  wp.x = roundTo2(pixelXToNormalized(pos.x, canvasWidth));
  wp.offset = roundTo2(clamp((baseY - pos.y) / lateralScale, -offsetLimit(), offsetLimit()));

  syncUIFromState();
  draw();
}

function onCanvasMouseMove(event: MouseEvent): void {
  if (!dragState) return;

  const pos = getCanvasCoords(event);
  if (!pos) return;

  if (dragRafPending) return;
  dragRafPending = true;

  requestAnimationFrame(() => {
    dragRafPending = false;
    applyDrag(pos);
  });
}

function onCanvasMouseUp(): void {
  dragState = null;
}

// ============================================================
//  PDF Export
// ============================================================

function getModalFieldValue(id: string): string {
  const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
  return (el && el.value) ? el.value : "-";
}

function setupPdfExport(): void {
  const button = document.getElementById("exportPdfButton");
  if (!button) return;

  button.addEventListener("click", () => {
    const jspdfModule = window.jspdf;
    if (!jspdfModule) {
      alert("jsPDF failed to load.");
      return;
    }

    const pdf = new jspdfModule.jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
    const margin = 10;
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const columnWidth = pageWidth / 2 - margin * 2;

    let imgBottomY = margin;
    let cursorX = margin;
    let cursorY = margin;

    function advanceY(amount: number): void {
      cursorY += amount;
    }

    function ensureSpace(needed: number): void {
      if (cursorY + needed <= pageHeight - margin) return;

      if (cursorX === margin) {
        cursorX = pageWidth / 2;
        cursorY = imgBottomY + 8;
      } else {
        pdf.addPage();
        cursorX = margin;
        cursorY = margin;
        imgBottomY = margin;
      }
    }

    function printText(text: string, fontSize: number): void {
      ensureSpace(fontSize * 0.4);
      pdf.setFontSize(fontSize);
      pdf.text(text, cursorX, cursorY);
    }

    imgBottomY = addCanvasImage(pdf, pageWidth, pageHeight, margin);
    cursorY = imgBottomY + 8;

    pdf.setFont("Times", "Normal");

    addScenarioSettings();
    addVehicleSettings();
    addAdvancedSettings();

    pdf.save("scenario.pdf");

    function addCanvasImage(pdfDoc: JsPDFInstance, pgW: number, pgH: number, mg: number): number {
      const scenarioCanvas = document.getElementById("scenarioCanvas") as HTMLCanvasElement | null;
      if (!scenarioCanvas) return mg;

      const dataURL = scenarioCanvas.toDataURL("image/png");
      const maxW = pgW - mg * 2;
      const maxH = pgH * 0.45;
      const props = pdfDoc.getImageProperties(dataURL);
      const ratio = Math.min(maxW / props.width, maxH / props.height);
      const imgW = props.width * ratio;
      const imgH = props.height * ratio;
      const imgX = (pgW - imgW) / 2;

      pdfDoc.addImage(dataURL, "PNG", imgX, mg, imgW, imgH);
      return mg + imgH;
    }

    function addScenarioSettings(): void {
      printText("Scenario Settings", 15);
      advanceY(7);

      printText(`Number of lanes: ${lanesPerSide}`, 11);
      advanceY(5);
      printText(`Total Distance: ${totalDistanceM} m`, 11);
      advanceY(7);
    }

    function addVehicleSettings(): void {
      for (const vehicle of vehicles) {
        if (!vehicle.enabled) continue;

        ensureSpace(20);

        printText(VEHICLE_DISPLAY_NAMES[vehicle.id] ?? vehicle.id, 12);
        advanceY(5);

        printText(`Lane: ${vehicle.lane}`, 10);
        advanceY(4);
        printText(`Speed: ${vehicle.speedKmh.toFixed(1)} km/h`, 10);
        advanceY(4);
        printText(`Smoothness: ${vehicle.smoothness.toFixed(1)}`, 10);
        advanceY(4);

        const wpStr = vehicle.waypoints
          .map((wp) => `(${wp.x.toFixed(1)}, ${wp.offset.toFixed(1)})`)
          .join(", ");
        pdf.setFontSize(10);
        const wpLines: string[] = pdf.splitTextToSize(`Waypoints: ${wpStr}`, columnWidth);
        for (const line of wpLines) {
          ensureSpace(4);
          pdf.text(line, cursorX, cursorY);
          advanceY(4);
        }

        if (vehicle.brakePoints.length > 0) {
          const bpStr = vehicle.brakePoints
            .map((bp) => `(${bp.x.toFixed(1)}, -${bp.decelerationMps2.toFixed(1)} m/s²)`)
            .join(", ");
          pdf.setFontSize(10);
          const bpLines: string[] = pdf.splitTextToSize(`Brake Points: ${bpStr}`, columnWidth);
          for (const line of bpLines) {
            ensureSpace(4);
            pdf.text(line, cursorX, cursorY);
            advanceY(4);
          }
        }

        advanceY(3);
      }
    }

    function addAdvancedSettings(): void {
      ensureSpace(20);
      advanceY(4);

      printText("Advanced Settings", 13);
      advanceY(6);

      printText("Road Settings", 11);
      advanceY(5);

      printText(`Lane Width: ${getModalFieldValue("road-width")} m`, 10);
      advanceY(7);

      ensureSpace(30);

      printText("Camera Settings", 11);
      advanceY(5);

      printText(
        `Location: X=${getModalFieldValue("cam-loc-x")} m, Y=${getModalFieldValue("cam-loc-y")} m, Z=${getModalFieldValue("cam-loc-z")} m`,
        10,
      );
      advanceY(4);

      printText(
        `Orientation: Bank=${getModalFieldValue("cam-bank")}°, Tilt=${getModalFieldValue("cam-tilt")}°, Heading=${getModalFieldValue("cam-heading")}°`,
        10,
      );
      advanceY(4);

      printText(
        `Parent Size: L=${getModalFieldValue("cam-length")} m, W=${getModalFieldValue("cam-width")} m, H=${getModalFieldValue("cam-height")} m`,
        10,
      );
      advanceY(5);

      printText(
        `Resolution: ${getModalFieldValue("cam-hres")} × ${getModalFieldValue("cam-vres")} px @ ${getModalFieldValue("cam-fps")} Hz`,
        10,
      );
      advanceY(4);

      printText(
        `Focal Length: ${getModalFieldValue("cam-focal")} mm, CCD: ${getModalFieldValue("cam-ccd")}`,
        10,
      );
      advanceY(4);

      const fovAz = getModalFieldValue("cam-fov-az");
      const fovEl = getModalFieldValue("cam-fov-el");
      if (fovAz !== "-" || fovEl !== "-") {
        printText(`FoV: Azimuth=${fovAz}\u00B0, Elevation=${fovEl}\u00B0`, 10);
        advanceY(4);
      }

      printText(
        `Clipping: Near=${getModalFieldValue("cam-near")} m, Far=${getModalFieldValue("cam-far")} m`,
        10,
      );
    }
  });
}

// ============================================================
//  Initialization
// ============================================================

setupModal();
setupUI();
syncUIFromState();
draw();
setupPdfExport();
