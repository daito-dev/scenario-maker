// ==== 型定義 ====

interface Waypoint {
  x: number;      // 0..1 (道路進行方向, 0=0m, 1=1000m)
  offset: number; // レーン中心からの横方向オフセット(laneHeight*0.5 単位)
}

interface BrakePoint {
  x: number;      // 0..1 (道路進行方向)
  decelerationMps2: number; // 減速度 [m/s²]
}

interface Vehicle {
  id: string;
  label: string;
  color: string;
  enabled: boolean;
  lane: number;       // 初期レーン
  waypoints: Waypoint[];
  smoothness: number; // 0..1 曲がり具合
  speedKmh: number;   // 速度 [km/h]
  brakePoints?: BrakePoint[]; // ブレーキポイント（Egoのみ）
}

interface DragState {
  vehicleIndex: number;
  waypointIndex: number;
  isBrakePoint?: boolean; // ブレーキポイントのドラッグか
  brakePointIndex?: number;
}

// ==== DOM ====

const canvas = document.getElementById("scenarioCanvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

const lanesInput = document.getElementById("lanesInput") as HTMLInputElement;
const distanceInput = document.getElementById("distanceInput") as HTMLInputElement;
const resetButton = document.getElementById("resetButton") as HTMLButtonElement;

let lanesPerSide = clamp(parseInt(lanesInput.value, 10) || 2, 1, 6);
let totalDistanceM = parseInt(distanceInput.value, 10) || 500; // x軸方向の総距離 [m]


//camera設定
const openBtn = document.getElementById("openCameraDialog")!;
const modal = document.getElementById("cameraModal")!;
const okBtn = document.getElementById("cameraModalOk")!;
const cancelBtn = document.getElementById("cameraModalCancel")!;

openBtn.onclick = () => modal.classList.add("show");
cancelBtn.onclick = () => modal.classList.remove("show");
okBtn.onclick = () => {
  // 入力値を読み取って cameraConfig に保存する処理など
  modal.classList.remove("show");
};
modal.addEventListener("click", (e) => {
  if (e.target === modal) modal.classList.remove("show");
});

// offset のクランプ範囲(±何レーン分まで動かせるか)
function offsetLimit(): number {
  return lanesPerSide * 1.5; // 例: 3レーンなら ±4.5 レーン相当まで
}

// ==== 車両状態 ====

const vehicles: Vehicle[] = [
  {
    id: "ego",
    label: "Ego",
    color: "#ff4444",
    enabled: true,
    lane: 1,
    smoothness: 0.3,
    speedKmh: 60,
    waypoints: [
      { x: 0, offset: 0 },
      { x: 0.5, offset: 0 },
      { x: 1, offset: 0 },
    ],
    brakePoints: [], // Ego用ブレーキポイント
  },
  {
    id: "npc1",
    label: "NPC 1",
    color: "#337bff",
    enabled: true,
    lane: 2,
    smoothness: 0.3,
    speedKmh: 60,
    waypoints: [
      { x: 0, offset: 0 },
      { x: 0.5, offset: 0 },
      { x: 1, offset: 0 },
    ],
  },
  {
    id: "npc2",
    label: "NPC 2",
    color: "#2ecc71",
    enabled: false,
    lane: 1,
    smoothness: 0.3,
    speedKmh: 60,
    waypoints: [],
  },
  {
    id: "npc3",
    label: "NPC 3",
    color: "#f39c12",
    enabled: false,
    lane: 2,
    smoothness: 0.3,
    speedKmh: 60,
    waypoints: [],
  },
];

let dragState: DragState | null = null;

// ==== ユーティリティ ====

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function parseWaypoints(text: string): Waypoint[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const res: Waypoint[] = [];
  for (const line of lines) {
    const parts = line.split(",");
    if (parts.length < 2) continue;
    const x = parseFloat(parts[0]);
    const off = parseFloat(parts[1]);
    if (isNaN(x) || isNaN(off)) continue;
    if (x < 0 || x > 1) continue;
    // 小数点第2位まで丸める
    res.push({ 
      x: Math.round(x * 100) / 100, 
      offset: Math.round(off * 100) / 100 
    });
  }
  // x でソート
  res.sort((a, b) => a.x - b.x);
  return res;
}

function waypointsToText(wps: Waypoint[]): string {
  const sorted = [...wps].sort((a, b) => a.x - b.x);
  return sorted.map((wp) => `${wp.x.toFixed(2)},${wp.offset.toFixed(2)}`).join("\n");
}

function parseBrakePoints(text: string): BrakePoint[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const res: BrakePoint[] = [];
  for (const line of lines) {
    const parts = line.split(",");
    if (parts.length < 2) continue;
    const x = parseFloat(parts[0]);
    const decel = parseFloat(parts[1]);
    if (isNaN(x) || isNaN(decel)) continue;
    if (x < 0 || x > 1) continue;
    // 小数点第2位まで丸める
    res.push({ 
      x: Math.round(x * 100) / 100, 
      decelerationMps2: Math.round(decel * 100) / 100 
    });
  }
  // x でソート
  res.sort((a, b) => a.x - b.x);
  return res;
}

function brakePointsToText(bps: BrakePoint[]): string {
  const sorted = [...bps].sort((a, b) => a.x - b.x);
  return sorted.map((bp) => `${bp.x.toFixed(2)},${bp.decelerationMps2.toFixed(2)}`).join("\n");
}

// Waypoint -> Canvas 座標変換
function waypointToCanvas(
  vehicle: Vehicle,
  wp: Waypoint,
  w: number,
  h: number
): { x: number; y: number } {
  const laneHeight = 80;
  const totalLaneHeight = laneHeight * lanesPerSide;
  const laneAreaTop = (h - totalLaneHeight) / 2;
  const laneAreaBottom = laneAreaTop + totalLaneHeight;

  const baseCenterY = laneAreaBottom - (vehicle.lane - 0.5) * laneHeight;
  const lateralScale = laneHeight * 0.5;

  // 左右の余白を考慮
  const marginLeft = 60;
  const marginRight = 20;
  const drawableWidth = w - marginLeft - marginRight;
  
  const xPix = marginLeft + clamp(wp.x, 0, 1) * drawableWidth;
  const yPix = baseCenterY - wp.offset * lateralScale;

  return { x: xPix, y: yPix };
}



// cubic Bézier 補間
function cubicBezierPoint(
  p0: { x: number; y: number },
  c1: { x: number; y: number },
  c2: { x: number; y: number },
  p3: { x: number; y: number },
  t: number
): { x: number; y: number } {
  const u = 1 - t;
  const tt = t * t;
  const uu = u * u;
  const uuu = uu * u;
  const ttt = tt * t;

  return {
    x: uuu * p0.x + 3 * uu * t * c1.x + 3 * u * tt * c2.x + ttt * p3.x,
    y: uuu * p0.y + 3 * uu * t * c1.y + 3 * u * tt * c2.y + ttt * p3.y,
  };
}

// ==== UI 初期化 ====

function setupUI(): void {
  // レーン数変更
  lanesInput.addEventListener("input", () => {
    const n = parseInt(lanesInput.value, 10);
    if (!isNaN(n)) {
      lanesPerSide = clamp(n, 1, 6);
      lanesInput.value = String(lanesPerSide);
      vehicles.forEach((v) => {
        v.lane = clamp(v.lane, 1, lanesPerSide);
      });
      syncUIFromState();
      draw();
    }
  });

  // 総距離変更
  distanceInput.addEventListener("input", () => {
    const d = parseInt(distanceInput.value, 10);
    if (!isNaN(d) && d > 0) {
      totalDistanceM = clamp(d, 100, 5000);
      distanceInput.value = String(totalDistanceM);
      draw();
    }
  });

  // 各 Vehicle パネル
  const panels = document.querySelectorAll<HTMLDivElement>(".vehicle-panel");
  panels.forEach((panel) => {
    const vehicleId = panel.dataset["vehicleId"];
    if (!vehicleId) return;
    const vi = vehicles.findIndex((v) => v.id === vehicleId);
    if (vi === -1) return;
    const vehicle = vehicles[vi];

    const enabledInput = panel.querySelector<HTMLInputElement>(
      ".vehicle-enabled"
    );
    const laneInput = panel.querySelector<HTMLInputElement>(".vehicle-lane");
    const colorInput = panel.querySelector<HTMLInputElement>(".vehicle-color");
    const speedInput = panel.querySelector<HTMLInputElement>(".vehicle-speed");
    const wpTextarea =
      panel.querySelector<HTMLTextAreaElement>(".vehicle-waypoints");
    const addWpButton =
      panel.querySelector<HTMLButtonElement>(".vehicle-add-wp");
    const smoothInput =
      panel.querySelector<HTMLInputElement>(".vehicle-smooth");
    const smoothValueSpan = panel.querySelector<HTMLSpanElement>(
      ".vehicle-smooth-value"
    );
    
    // Ego専用: ブレーキポイント
    const bpTextarea =
      panel.querySelector<HTMLTextAreaElement>(".vehicle-brakepoints");
    const addBpButton =
      panel.querySelector<HTMLButtonElement>(".vehicle-add-bp");

    if (enabledInput) {
      enabledInput.checked = vehicle.enabled;
      enabledInput.addEventListener("change", () => {
        vehicle.enabled = enabledInput.checked;
        draw();
      });
    }

    if (laneInput) {
      laneInput.value = String(vehicle.lane);
      laneInput.addEventListener("input", () => {
        const n = parseInt(laneInput.value, 10);
        if (!isNaN(n)) {
          vehicle.lane = clamp(n, 1, lanesPerSide);
          laneInput.value = String(vehicle.lane);
          draw();
        }
      });
    }

    if (colorInput) {
      colorInput.value = vehicle.color;
      colorInput.addEventListener("input", () => {
        vehicle.color = colorInput.value;
        draw();
      });
    }

    if (speedInput) {
      speedInput.value = String(vehicle.speedKmh);
      speedInput.addEventListener("input", () => {
        const vnum = parseFloat(speedInput.value);
        if (!isNaN(vnum) && vnum >= 0) {
          vehicle.speedKmh = vnum;
          draw();
        }
      });
    }

    if (wpTextarea) {
      wpTextarea.value = waypointsToText(vehicle.waypoints);
      wpTextarea.addEventListener("input", () => {
        vehicle.waypoints = parseWaypoints(wpTextarea.value).slice(0, 10);
        draw();
      });
    }

    if (addWpButton) {
      addWpButton.addEventListener("click", () => {
        if (vehicle.waypoints.length >= 10) return;
        let newX = 0.5;
        if (vehicle.waypoints.length > 0) {
          const last = vehicle.waypoints[vehicle.waypoints.length - 1];
          newX = clamp(last.x + 0.1, 0, 1);
        }
        const newWp: Waypoint = {
          x: newX,
          offset: 0,
        };
        vehicle.waypoints.push(newWp);
        syncUIFromState();
        draw();
      });
    }

    // ブレーキポイント処理 (Egoのみ)
    if (bpTextarea && vehicle.id === "ego") {
      if (vehicle.brakePoints) {
        bpTextarea.value = brakePointsToText(vehicle.brakePoints);
      }
      bpTextarea.addEventListener("input", () => {
        if (vehicle.brakePoints) {
          vehicle.brakePoints = parseBrakePoints(bpTextarea.value).slice(0, 10);
          draw();
        }
      });
    }

    if (addBpButton && vehicle.id === "ego") {
      addBpButton.addEventListener("click", () => {
        if (!vehicle.brakePoints || vehicle.brakePoints.length >= 10) return;
        let newX = 0.5;
        if (vehicle.brakePoints.length > 0) {
          const last = vehicle.brakePoints[vehicle.brakePoints.length - 1];
          newX = clamp(last.x + 0.1, 0, 1);
        }
        const newBp: BrakePoint = {
          x: newX,
          decelerationMps2: 3.0, // デフォルト減速度 3.0 m/s²
        };
        vehicle.brakePoints.push(newBp);
        syncUIFromState();
        draw();
      });
    }

    if (smoothInput && smoothValueSpan) {
      smoothInput.value = String(vehicle.smoothness);
      smoothValueSpan.textContent = vehicle.smoothness.toFixed(1);
      smoothInput.addEventListener("input", () => {
        const v = parseFloat(smoothInput.value);
        if (!isNaN(v)) {
          vehicle.smoothness = clamp(v, 0, 1);
          smoothValueSpan.textContent = vehicle.smoothness.toFixed(1);
          draw();
        }
      });
    }
  });

  // リセット
  resetButton.addEventListener("click", () => {
    lanesPerSide = 2;
    lanesInput.value = "2";
    totalDistanceM = 500;

    vehicles[0].enabled = true;
    vehicles[0].lane = 1;
    vehicles[0].color = "#ff4444";
    vehicles[0].smoothness = 0.7;
    vehicles[0].speedKmh = 72;
    vehicles[0].waypoints = [
      { x: 0, offset: 0 },
      { x: 1, offset: 0 },
    ];
    vehicles[0].brakePoints = [];

    vehicles[1].enabled = true;
    vehicles[1].lane = 2;
    vehicles[1].color = "#337bff";
    vehicles[1].smoothness = 0.7;
    vehicles[1].speedKmh = 60;
    vehicles[1].waypoints = [
      { x: 0, offset: 0 },
      { x: 0.5, offset: 0 },
      { x: 1, offset: 0 },
    ];

    vehicles[2].enabled = false;
    vehicles[2].lane = 1;
    vehicles[2].color = "#2ecc71";
    vehicles[2].smoothness = 0.7;
    vehicles[2].speedKmh = 72;
    vehicles[2].waypoints = [];

    vehicles[3].enabled = false;
    vehicles[3].lane = 1;
    vehicles[3].color = "#f39c12";
    vehicles[3].smoothness = 0.7;
    vehicles[3].speedKmh = 72;
    vehicles[3].waypoints = [];

    syncUIFromState();
    draw();
  });

  // ウィンドウリサイズ時にキャンバスサイズを調整
  function resizeCanvas(): void {
    const container = document.getElementById("canvasContainer");
    if (!container) return;
    
    const rect = container.getBoundingClientRect();
    const padding = 40; // コンテナの余白
    
    // 利用可能なスペース
    const availableWidth = rect.width - padding;
    const availableHeight = rect.height - padding;
    
    // キャンバスの内部解像度を設定
    canvas.width = Math.max(400, availableWidth);
    canvas.height = Math.max(200, availableHeight);
    
    draw();
  }

  // 初回リサイズ
  resizeCanvas();

  // ウィンドウリサイズ時に再調整
  window.addEventListener("resize", resizeCanvas);

  canvas.addEventListener("mousedown", onCanvasMouseDown);
  window.addEventListener("mousemove", onCanvasMouseMove);
  window.addEventListener("mouseup", onCanvasMouseUp);
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

    const enabledInput = panel.querySelector<HTMLInputElement>(
      ".vehicle-enabled"
    );
    const laneInput = panel.querySelector<HTMLInputElement>(".vehicle-lane");
    const colorInput = panel.querySelector<HTMLInputElement>(".vehicle-color");
    const speedInput = panel.querySelector<HTMLInputElement>(".vehicle-speed");
    const wpTextarea =
      panel.querySelector<HTMLTextAreaElement>(".vehicle-waypoints");
    const bpTextarea =
      panel.querySelector<HTMLTextAreaElement>(".vehicle-brakepoints");
    const smoothInput =
      panel.querySelector<HTMLInputElement>(".vehicle-smooth");
    const smoothValueSpan = panel.querySelector<HTMLSpanElement>(
      ".vehicle-smooth-value"
    );

    if (enabledInput) enabledInput.checked = vehicle.enabled;
    if (laneInput) laneInput.value = String(vehicle.lane);
    if (colorInput) colorInput.value = vehicle.color;
    if (speedInput) speedInput.value = String(vehicle.speedKmh);
    if (wpTextarea) wpTextarea.value = waypointsToText(vehicle.waypoints);
    if (bpTextarea && vehicle.brakePoints) {
      bpTextarea.value = brakePointsToText(vehicle.brakePoints);
    }
    if (smoothInput && smoothValueSpan) {
      smoothInput.value = String(vehicle.smoothness);
      smoothValueSpan.textContent = vehicle.smoothness.toFixed(1);
    }
  });
}

// ==== 描画 ====

function draw(): void {
  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);

  // 背景
  ctx.fillStyle = "#1f2933";
  ctx.fillRect(0, 0, w, h);

  // ============================
  // 1. x 軸方向の距離グリッド
  // ============================
  // 左右の余白
  const marginLeft = 60;
  const marginRight = 20;
  const drawableWidth = w - marginLeft - marginRight;
  
  // グリッド間隔を自動調整
  let stepM: number;
  if (totalDistanceM <= 500) {
    stepM = 50;
  } else if (totalDistanceM <= 1000) {
    stepM = 100;
  } else if (totalDistanceM <= 2000) {
    stepM = 200;
  } else {
    stepM = 500;
  }
  
  const nSteps = totalDistanceM / stepM;

  ctx.lineWidth = 1;

  for (let i = 0; i <= nSteps; i++) {
    const t = i / nSteps; // 0..1
    const xPix = marginLeft + t * drawableWidth;

    // 縦の点線
    ctx.save();
    ctx.setLineDash([4, 8]);
    ctx.strokeStyle = "#374151";
    ctx.beginPath();
    ctx.moveTo(xPix, 0);
    ctx.lineTo(xPix, h);
    ctx.stroke();
    ctx.restore();

    // x 軸の目盛り(下端)
    const yAxis = h - 4;

    ctx.strokeStyle = "#9ca3af";
    ctx.beginPath();
    ctx.moveTo(xPix, yAxis);
    ctx.lineTo(xPix, h);
    ctx.stroke();

    ctx.fillStyle = "#9ca3af";
    ctx.font = "10px 'Times New Roman', serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";

    const distLabel = `${i * stepM}m`;
    ctx.fillText(distLabel, xPix, yAxis - 2);
  }

  // x 軸のベースライン
  ctx.strokeStyle = "#9ca3af";
  ctx.beginPath();
  ctx.moveTo(marginLeft, h);
  ctx.lineTo(marginLeft + drawableWidth, h);
  ctx.stroke();

  // ============================
  // 2. レーン(高さ 80px 固定)
  // ============================
  const laneHeight = 80;                       // ★ レーン幅 80px 固定
  const totalLaneHeight = laneHeight * lanesPerSide;
  const laneAreaTop = (h - totalLaneHeight) / 2;
  const laneAreaBottom = laneAreaTop + totalLaneHeight;

  // レーン横線
  ctx.strokeStyle = "#4b5563";
  ctx.lineWidth = 1;
  for (let i = 0; i <= lanesPerSide; i++) {
    const y = laneAreaTop + i * laneHeight;
    ctx.beginPath();
    ctx.moveTo(marginLeft, y);
    ctx.lineTo(marginLeft + drawableWidth, y);
    ctx.stroke();
  }

  // レーン番号(Lane1 が一番下、LaneN が一番上)
  ctx.fillStyle = "#9ca3af";
  ctx.font = "12px 'Times New Roman', serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (let lane = 1; lane <= lanesPerSide; lane++) {
    const centerY = laneAreaBottom - (lane - 0.5) * laneHeight;
    ctx.fillText(`Lane ${lane}`, 8, centerY);
  }

  // ============================
  // 3. 車両の軌跡 & 時間プロット
  // ============================
  const pixelsPerMeterX = drawableWidth / totalDistanceM; // x方向: totalDistanceM → 描画可能幅

  vehicles.forEach((v) => {
    if (!v.enabled) return;

    const wpsSorted = [...v.waypoints].sort((a, b) => a.x - b.x);
    if (wpsSorted.length === 0) return;

    const pts = wpsSorted.map((wp) => waypointToCanvas(v, wp, w, h));

    ctx.strokeStyle = v.color;
    ctx.lineWidth = 2;

    // 軌跡サンプル(時間プロットにも使う)
    const pathSamples: { x: number; y: number }[] = [];

    // ---- 軌跡(線)の描画 ----
    if (pts.length === 1) {
      pathSamples.push({ x: pts[0].x, y: pts[0].y });
    } else if (v.smoothness <= 0.01 || pts.length === 2) {
      // 折れ線
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      pathSamples.push({ x: pts[0].x, y: pts[0].y });

      const stepsPerSegment = 20;
      for (let i = 0; i < pts.length - 1; i++) {
        const p1 = pts[i];
        const p2 = pts[i + 1];

        for (let s = 1; s <= stepsPerSegment; s++) {
          const t = s / stepsPerSegment;
          const x = p1.x + (p2.x - p1.x) * t;
          const y = p1.y + (p2.y - p1.y) * t;

          ctx.lineTo(x, y);
          pathSamples.push({ x, y });
        }
      }
      ctx.stroke();
    } else {
      // Bézier 曲線で滑らかに
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      pathSamples.push({ x: pts[0].x, y: pts[0].y });

      const factor = 0.35 * v.smoothness;  // 曲がり具合
      const stepsPerSegment = 24;
      const n = pts.length;

      for (let i = 0; i < n - 1; i++) {
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const segVx = p2.x - p1.x;
        const segVy = p2.y - p1.y;
        const segLen = Math.hypot(segVx, segVy);
        if (segLen < 1e-3) {
          ctx.lineTo(p2.x, p2.y);
          pathSamples.push({ x: p2.x, y: p2.y });
          continue;
        }

        // 始点側接線方向
        let prevDirX: number;
        let prevDirY: number;
        if (i === 0) {
          prevDirX = segVx / segLen;
          prevDirY = segVy / segLen;
        } else {
          const p0 = pts[i - 1];
          const vx = p1.x - p0.x;
          const vy = p1.y - p0.y;
          const l = Math.hypot(vx, vy) || 1;
          prevDirX = vx / l;
          prevDirY = vy / l;
        }

        // 終点側接線方向
        let nextDirX: number;
        let nextDirY: number;
        if (i + 2 >= n) {
          nextDirX = segVx / segLen;
          nextDirY = segVy / segLen;
        } else {
          const p3 = pts[i + 2];
          const vx = p3.x - p2.x;
          const vy = p3.y - p2.y;
          const l = Math.hypot(vx, vy) || 1;
          nextDirX = vx / l;
          nextDirY = vy / l;
        }

        const d1 = segLen * factor;
        const d2 = segLen * factor;

        const c1 = { x: p1.x + prevDirX * d1, y: p1.y + prevDirY * d1 };
        const c2 = { x: p2.x - nextDirX * d2, y: p2.y - nextDirY * d2 };

        for (let s = 1; s <= stepsPerSegment; s++) {
          const t = s / stepsPerSegment;
          const q = cubicBezierPoint(p1, c1, c2, p2, t);
          ctx.lineTo(q.x, q.y);
          pathSamples.push(q);
        }
      }
      ctx.stroke();
    }

    // ---- Waypoint の描画 ----
    wpsSorted.forEach((wp, idx) => {
      const pos = waypointToCanvas(v, wp, w, h);

      // 塗りつぶし丸
      ctx.beginPath();
      ctx.fillStyle = v.color;
      ctx.arc(pos.x, pos.y, 6, 0, Math.PI * 2);
      ctx.fill();

      // 外側の白円
      ctx.beginPath();
      ctx.strokeStyle = "#ffffffaa";
      ctx.lineWidth = 1;
      ctx.arc(pos.x, pos.y, 8, 0, Math.PI * 2);
      ctx.stroke();

      // index ラベル
      ctx.fillStyle = "#e5e7eb";
      ctx.font = "10px 'Times New Roman', serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(idx), pos.x, pos.y - 12);
    });

    // ---- ブレーキポイントの描画 (Egoのみ) ----
    if (v.id === "ego" && v.brakePoints) {
      v.brakePoints.forEach((bp, idx) => {
        const marginLeft = 60;
        const marginRight = 20;
        const drawableWidth = w - marginLeft - marginRight;
        const xPix = marginLeft + bp.x * drawableWidth;
        
        // ブレーキポイントの位置を軌跡上で計算
        let yPix = h / 2; // デフォルト
        
        // 軌跡サンプルから対応するy座標を見つける
        if (pathSamples.length >= 2) {
          let j = 0;
          while (j < pathSamples.length - 1 && pathSamples[j + 1].x < xPix) {
            j++;
          }
          const pA = pathSamples[j];
          const pB = pathSamples[Math.min(j + 1, pathSamples.length - 1)];
          const dx = pB.x - pA.x || 1;
          const alpha = clamp((xPix - pA.x) / dx, 0, 1);
          yPix = pA.y + (pB.y - pA.y) * alpha;
        }
        
        // ブレーキマーク（三角形）
        ctx.beginPath();
        ctx.fillStyle = "#ffaa00";
        ctx.moveTo(xPix, yPix - 10);
        ctx.lineTo(xPix - 6, yPix - 20);
        ctx.lineTo(xPix + 6, yPix - 20);
        ctx.closePath();
        ctx.fill();
        
        // 枠線
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1;
        ctx.stroke();
        
        // 減速度ラベル
        ctx.fillStyle = "#ffffff";
        ctx.font = "9px 'Times New Roman', serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillText(`${bp.decelerationMps2.toFixed(1)}m/s²`, xPix, yPix - 22);
      });
    }

    // ---- 時間・速度に基づく点プロット ----
    const samplesForTime =
      pathSamples.length >= 2 ? pathSamples : pts.map((p) => ({ ...p }));
    if (samplesForTime.length < 2) return;

    const startXPix = samplesForTime[0].x;
    const maxXPix = samplesForTime[samplesForTime.length - 1].x;

    const speedMps = Math.max(0, v.speedKmh / 3.6); // km/h -> m/s
    if (speedMps <= 0) return;

    // 軌跡の総距離を計算
    const startXNormalized = (samplesForTime[0].x - 60) / (w - 80); // 余白を考慮
    const maxXNormalized = (samplesForTime[samplesForTime.length - 1].x - 60) / (w - 80);
    const trajectoryDistanceM = (maxXNormalized - startXNormalized) * totalDistanceM;
    
    const durationSec = trajectoryDistanceM / speedMps; // 軌跡全体を走行する時間
    const dt = 0.5;        // 0.5秒刻み

    for (let tSec = 0; tSec <= durationSec + 1e-6; tSec += dt) {
      const distM = speedMps * tSec; // [m]
      const targetX = startXPix + distM * pixelsPerMeterX;

      if (targetX > maxXPix) break;

      // targetX 近辺のサンプルを線形補間
      let j = 0;
      while (
        j < samplesForTime.length - 1 &&
        samplesForTime[j + 1].x < targetX
      ) {
        j++;
      }
      const pA = samplesForTime[j];
      const pB = samplesForTime[Math.min(j + 1, samplesForTime.length - 1)];
      const dx = pB.x - pA.x || 1;
      const alpha = clamp((targetX - pA.x) / dx, 0, 1);
      const yPix = pA.y + (pB.y - pA.y) * alpha;

      // 小さい塗りつぶし点
      ctx.beginPath();
      ctx.fillStyle = v.color;
      ctx.arc(targetX, yPix, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}


// ==== マウス操作(ウェイポイントドラッグ) ====

function getCanvasCoords(evt: MouseEvent): { x: number; y: number } | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const x = (evt.clientX - rect.left) * scaleX;
  const y = (evt.clientY - rect.top) * scaleY;
  return { x, y };
}

function onCanvasMouseDown(evt: MouseEvent): void {
  const pos = getCanvasCoords(evt);
  if (!pos) return;

  const w = canvas.width;
  const h = canvas.height;
  const hitRadius = 10;

  // まずブレーキポイントをチェック（Egoのみ）
  for (let vi = 0; vi < vehicles.length; vi++) {
    const v = vehicles[vi];
    if (!v.enabled || v.id !== "ego" || !v.brakePoints) continue;

    for (let bi = 0; bi < v.brakePoints.length; bi++) {
      const bp = v.brakePoints[bi];
      const marginLeft = 60;
      const marginRight = 20;
      const drawableWidth = w - marginLeft - marginRight;
      const xPix = marginLeft + bp.x * drawableWidth;
      
      // y座標を軌跡から取得
      const wpsSorted = [...v.waypoints].sort((a, b) => a.x - b.x);
      const pts = wpsSorted.map((wp) => waypointToCanvas(v, wp, w, h));
      const pathSamples: { x: number; y: number }[] = [];
      
      // 簡易的にptsをpathSamplesとして使用
      pts.forEach(p => pathSamples.push(p));
      
      let yPix = h / 2;
      if (pathSamples.length >= 2) {
        let j = 0;
        while (j < pathSamples.length - 1 && pathSamples[j + 1].x < xPix) {
          j++;
        }
        const pA = pathSamples[j];
        const pB = pathSamples[Math.min(j + 1, pathSamples.length - 1)];
        const dx = pB.x - pA.x || 1;
        const alpha = clamp((xPix - pA.x) / dx, 0, 1);
        yPix = pA.y + (pB.y - pA.y) * alpha;
      }
      
      const dx = xPix - pos.x;
      const dy = yPix - 15 - pos.y; // 三角形の中心付近
      if (dx * dx + dy * dy <= hitRadius * hitRadius) {
        dragState = { 
          vehicleIndex: vi, 
          waypointIndex: 0, 
          isBrakePoint: true,
          brakePointIndex: bi
        };
        return;
      }
    }
  }

  // 次にウェイポイントをチェック
  for (let vi = 0; vi < vehicles.length; vi++) {
    const v = vehicles[vi];
    if (!v.enabled) continue;

    for (let wi = 0; wi < v.waypoints.length; wi++) {
      const wp = v.waypoints[wi];
      const p = waypointToCanvas(v, wp, w, h);
      const dx = p.x - pos.x;
      const dy = p.y - pos.y;
      if (dx * dx + dy * dy <= hitRadius * hitRadius) {
        dragState = { vehicleIndex: vi, waypointIndex: wi };
        return;
      }
    }
  }
  dragState = null;
}

function onCanvasMouseMove(evt: MouseEvent): void {
  if (!dragState) return;
  const pos = getCanvasCoords(evt);
  if (!pos) return;

  const v = vehicles[dragState.vehicleIndex];
  
  // ブレーキポイントのドラッグ
  if (dragState.isBrakePoint && dragState.brakePointIndex !== undefined && v.brakePoints) {
    const bp = v.brakePoints[dragState.brakePointIndex];
    const w = canvas.width;
    const marginLeft = 60;
    const marginRight = 20;
    const drawableWidth = w - marginLeft - marginRight;
    const newX = clamp((pos.x - marginLeft) / drawableWidth, 0, 1);
    bp.x = Math.round(newX * 100) / 100; // 小数点第2位まで
    syncUIFromState();
    draw();
    return;
  }
  
  // ウェイポイントのドラッグ
  const wp = v.waypoints[dragState.waypointIndex];

  const w = canvas.width;
  const h = canvas.height;
  const marginLeft = 60;
  const marginRight = 20;
  const drawableWidth = w - marginLeft - marginRight;
  const laneHeight = 80;
  const totalLaneHeight = laneHeight * lanesPerSide;
  const laneAreaTop = (h - totalLaneHeight) / 2;
  const laneAreaBottom = laneAreaTop + totalLaneHeight;
  const baseCenterY = laneAreaBottom - (v.lane - 0.5) * laneHeight;
  const lateralScale = laneHeight * 0.5;

  const newX = clamp((pos.x - marginLeft) / drawableWidth, 0, 1);
  const newOffset = clamp(
    (baseCenterY - pos.y) / lateralScale,
    -offsetLimit(),
    offsetLimit()
  );

  wp.x = Math.round(newX * 100) / 100; // 小数点第2位まで
  wp.offset = Math.round(newOffset * 100) / 100; // 小数点第2位まで

  syncUIFromState();
  draw();
}

function onCanvasMouseUp(_evt: MouseEvent): void {
  dragState = null;
}

// =====================
//     PDF EXPORT
// =====================
function setupPdfExport(): void {
  const button = document.getElementById("exportPdfButton");
  if (!button) return;

  // 複数 ID 候補から最初に見つかった value を返すヘルパ
  const getFieldValue = (ids: string[]): string => {
    for (const id of ids) {
      const el = document.getElementById(id) as
        | HTMLInputElement
        | HTMLSelectElement
        | null;
      if (el && typeof el.value === "string" && el.value !== "") {
        return el.value;
      }
    }
    return "-";
  };

  button.addEventListener("click", () => {
    const jspdfModule = (window as any).jspdf;
    if (!jspdfModule) {
      alert("jsPDF failed to load.");
      return;
    }
    const { jsPDF } = jspdfModule;

    // A4 landscape
    const pdf = new jsPDF({
      orientation: "landscape",
      unit: "mm",
      format: "a4",
    });

    const margin = 10;
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const columnWidth = pageW / 2 - margin * 2;

    let imgBottomY = margin;

    const canvas = document.getElementById(
      "scenarioCanvas"
    ) as HTMLCanvasElement | null;

    if (canvas) {
      const dataURL = canvas.toDataURL("image/png");

      const maxW = pageW - margin * 2;
      const maxH = pageH * 0.45;

      const props = pdf.getImageProperties(dataURL);
      const ratio = Math.min(maxW / props.width, maxH / props.height);

      const w = props.width * ratio;
      const h = props.height * ratio;

      const imgX = (pageW - w) / 2;
      const imgY = margin;

      pdf.addImage(dataURL, "PNG", imgX, imgY, w, h);

      imgBottomY = imgY + h; 
    }
    let x = margin;
    let y = imgBottomY + 8;

    pdf.setFont("Times", "Normal");
    const textBottomLimit = pageH - margin;
    const secondColumnX = pageW / 2;

    const moveToNextColumnIfNeeded = () => {
      if (y > textBottomLimit && x === margin) {
        x = secondColumnX;
        y = imgBottomY + 8;
      }
    };

    // ----- Scenario Settings -----
    pdf.setFontSize(15);
    pdf.text("Scenario Settings", x, y);
    y += 7;

    pdf.setFontSize(11);
    pdf.text(`Number of lanes: ${lanesPerSide}`, x, y);
    y += 5;
    pdf.text(`Total Distance: ${totalDistanceM} m`, x, y);
    y += 7;

    // ----- Vehicles -----
    const nameOf = (id: string): string => {
      switch (id) {
        case "ego": return "Ego Vehicle";
        case "npc1": return "NPC 1";
        case "npc2": return "NPC 2";
        case "npc3": return "NPC 3";
        default:    return id;
      }
    };

    vehicles.forEach((v) => {
      if (!v.enabled) return;

      moveToNextColumnIfNeeded();

      pdf.setFontSize(12);
      pdf.text(nameOf(v.id), x, y);
      y += 5;

      pdf.setFontSize(10);
      pdf.text(`Lane: ${v.lane}`, x, y); y += 4;
      pdf.text(`Speed: ${v.speedKmh.toFixed(1)} km/h`, x, y); y += 4;
      pdf.text(`Smoothness: ${v.smoothness.toFixed(1)}`, x, y); y += 4;

      // ---- Waypoints（長くなったら自動改行）----
      const wpStr = v.waypoints
        .map((w) => `(${w.x.toFixed(1)}, ${w.offset.toFixed(1)})`)
        .join(", ");
      const wpLines = pdf.splitTextToSize(
        `Waypoints: ${wpStr}`,
        columnWidth
      );
      wpLines.forEach((line: string) => {
        pdf.text(line, x, y);
        y += 4;
      });


      // ---- Brake Points も同じく折り返し ----
      if (v.brakePoints && v.brakePoints.length > 0) {
        const bpStr = v.brakePoints
          .map(
            (bp) =>
              `(${bp.x.toFixed(1)}, -${bp.decelerationMps2.toFixed(1)} m/s²)`
          )
          .join(", ");
        const bpLines = pdf.splitTextToSize(
          `Brake Points: ${bpStr}`,
          columnWidth
        );
        bpLines.forEach((line: string) => {
  pdf.text(line, x, y);
  y += 4;
});

      }

      y += 3;
    });

    // ----- Advanced Settings -----
    moveToNextColumnIfNeeded();
    y += 4;

    pdf.setFontSize(13);
    pdf.text("Advanced Settings", x, y);
    y += 6;

    // Road Settings
    pdf.setFontSize(11);
    pdf.text("Road Settings", x, y);
    y += 5;

    pdf.setFontSize(10);
    const laneWidthStr = getFieldValue(["laneWidthInput", "road-width"]);
    pdf.text(`Lane Width: ${laneWidthStr} m`, x, y);
    y += 7;

    moveToNextColumnIfNeeded();

    // Camera Settings
    pdf.setFontSize(11);
    pdf.text("Camera Settings", x, y);
    y += 5;
    pdf.setFontSize(10);

    const camLocX  = getFieldValue(["camLocX",  "cam-loc-x"]);
    const camLocY  = getFieldValue(["camLocY",  "cam-loc-y"]);
    const camLocZ  = getFieldValue(["camLocZ",  "cam-loc-z"]);
    const camBank  = getFieldValue(["camBank",  "cam-bank"]);
    const camTilt  = getFieldValue(["camTilt",  "cam-tilt"]);
    const camHead  = getFieldValue(["camHeading", "cam-heading"]);

    const parentLen = getFieldValue(["parentLength", "parent-length"]);
    const parentWid = getFieldValue(["parentWidth",  "parent-width"]);
    const parentHei = getFieldValue(["parentHeight", "parent-height"]);

    const camResX  = getFieldValue(["camResX",  "cam-hres"]);
    const camResY  = getFieldValue(["camResY",  "cam-vres"]);
    const camFps   = getFieldValue(["camFps",   "cam-fps"]);
    const camFocal = getFieldValue(["camFocal", "cam-focal"]);

    const ccdSize  = getFieldValue(["ccdSize",  "cam-ccd"]);
    const fovAz    = getFieldValue(["camFovAz", "cam-fov-az"]);
    const fovEl    = getFieldValue(["camFovEl", "cam-fov-el"]);
    const nearClip = getFieldValue(["nearClip", "cam-near"]);
    const farClip  = getFieldValue(["farClip",  "cam-far"]);

    pdf.text(
      `Location: X=${camLocX} m, Y=${camLocY} m, Z=${camLocZ} m`,
      x,
      y
    ); y += 4;

    pdf.text(
      `Orientation: Bank=${camBank}°, Tilt=${camTilt}°, Heading=${camHead}°`,
      x,
      y
    ); y += 4;

    pdf.text(
      `Parent Size: L=${parentLen} m, W=${parentWid} m, H=${parentHei} m`,
      x,
      y
    ); y += 5;

    pdf.text(
      `Resolution: ${camResX} × ${camResY} px @ ${camFps} Hz`,
      x,
      y
    ); y += 4;

    pdf.text(`Focal Length: ${camFocal} mm, CCD: ${ccdSize}`, x, y); y += 4;

    if (fovAz !== "-" || fovEl !== "-") {
      pdf.text(
        `FoV: Azimuth=${fovAz}°, Elevation=${fovEl}°`,
        x,
        y
      ); y += 4;
    }

    pdf.text(
      `Clipping: Near=${nearClip} m, Far=${farClip} m`,
      x,
      y
    );

    pdf.save("scenario.pdf");
  });
}



// ==== 初期化 ====

setupUI();
syncUIFromState();
draw();
setupPdfExport();
