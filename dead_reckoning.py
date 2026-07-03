"""
2D top-down dead-reckoning layout tool for RoboSub 2026 (Woollett Aquatics Center).

For the people doing the reckoning
----------------------------------
* "Reckon" tab: place the AprilTag origin, drag/type task props into the pool, read the
  numbers that go straight into the mapping config.
* "Props" tab: set up props once — hierarchy/parenting, footprint, color, top-down image,
  covariance, flags.
* "Pool" tab: line layout + display options.

Map frame
---------
The map frame is the AprilTag frame (ROS REP-103): +X into the pool, +Y left, +Z up,
yaw CCW+ about +Z. Every object's pose is stored relative to its parent frame, exactly like
riptide_mapping's config.yaml. Objects with parent = "map" are placed directly in the map
(AprilTag) frame; children compose through their parent's frame (yaw-only rotation + z add).

Mapping config
--------------
File > Load mapping config  reads riptide_mapping config.yaml (talos/liltank namespace)
File > Save mapping config  writes it back, preserving comments/order via ruamel.yaml.

Install:
    python -m pip install PySide6 ruamel.yaml
Run:
    python dead_reckoning.py
Self-test (no GUI):
    python dead_reckoning.py --selftest
"""

from __future__ import annotations

import csv
import hashlib
import json
import math
import sys
from dataclasses import dataclass, field
from pathlib import Path

from PySide6.QtCore import Qt, QPointF, QRectF, Signal
from PySide6.QtGui import (
    QAction,
    QBrush,
    QColor,
    QFont,
    QKeySequence,
    QPainter,
    QPainterPath,
    QPen,
    QPixmap,
    QPolygonF,
    QTransform,
)
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QColorDialog,
    QComboBox,
    QDoubleSpinBox,
    QFileDialog,
    QFormLayout,
    QFrame,
    QGridLayout,
    QGraphicsItem,
    QGraphicsObject,
    QGraphicsScene,
    QGraphicsSimpleTextItem,
    QGraphicsView,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QInputDialog,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QSizePolicy,
    QSpinBox,
    QSplitter,
    QToolBar,
    QToolButton,
    QTreeWidget,
    QTreeWidgetItem,
    QVBoxLayout,
    QWidget,
)

try:
    from ruamel.yaml import YAML
    from ruamel.yaml.comments import CommentedMap
    _HAVE_RUAMEL = True
except Exception:  # pragma: no cover
    _HAVE_RUAMEL = False


# ----------------------------- constants -----------------------------

M_PER_FT = 0.3048
FT_PER_M = 1.0 / M_PER_FT
M_PER_YD = 0.9144

POOL_LENGTH_M = 50.0                 # long dimension, world +X
POOL_WIDTH_M = 25.0 * M_PER_YD       # short dimension, world +Y  (= 22.86 m)
POOL_DEPTH_M = 7.0 * M_PER_FT        # 7 ft (2.1336 m)

DEFAULT_NINE_FT_M = 9.0 * M_PER_FT   # 2.7432 m
MAP = "map"

# z-order
Z_WATER = -100
Z_GRID = -90
Z_LINES = -50
Z_TAG = 50
Z_LOCKED = 55       # locked props sit below interactive ones (e.g. the table under its props)
Z_PROP = 100
Z_LABEL = 120

# Columns of the unified objects tree: Object | 🔒 | 🚫 | x | y | z | yaw
TABLE_LOCK_COL = 1
TABLE_HIDE_COL = 2
TREE_POSE_COLS = (3, 4, 5, 6)


# ----------------------------- math helpers -----------------------------

def norm_deg(a: float) -> float:
    """Wrap an angle to (-180, 180]."""
    a = (a + 180.0) % 360.0 - 180.0
    return 180.0 if a == -180.0 else a


def centered_positions(dimension_m: float, count: int, spacing_m: float) -> list[float]:
    if count <= 0:
        return []
    span = (count - 1) * spacing_m
    start = (dimension_m - span) / 2.0
    return [start + i * spacing_m for i in range(count)]


def world_to_scene(x: float, y: float) -> QPointF:
    """World frame (Y up, origin at pool corner) -> Qt scene (Y down)."""
    return QPointF(x, POOL_WIDTH_M - y)


def scene_to_world(x: float, y: float) -> tuple[float, float]:
    return x, POOL_WIDTH_M - y


def compose(parent_pose: tuple, child_rel: tuple) -> tuple:
    """parent map pose (x,y,z,yaw) o child pose relative to parent -> child map pose."""
    px, py, pz, pyaw = parent_pose
    x, y, z, yaw = child_rel
    a = math.radians(pyaw)
    c, s = math.cos(a), math.sin(a)
    return (px + x * c - y * s, py + x * s + y * c, pz + z, norm_deg(pyaw + yaw))


def decompose(parent_pose: tuple, child_map: tuple) -> tuple:
    """Inverse of compose: child map pose -> pose relative to parent."""
    px, py, pz, pyaw = parent_pose
    mx, my, mz, myaw = child_map
    a = math.radians(pyaw)
    c, s = math.cos(a), math.sin(a)
    dx, dy = mx - px, my - py
    return (dx * c + dy * s, -dx * s + dy * c, mz - pz, norm_deg(myaw - pyaw))


# ----------------------------- data model -----------------------------

@dataclass
class Tag:
    """AprilTag = map-frame origin: a point on a wall at the water line, looking into the pool."""
    x: float
    y: float
    base_phi: float          # inward wall normal, deg CCW from world +X
    wall: str                # 'N' | 'S' | 'E' | 'W'
    yaw_offset: float = 0.0  # user fine-tune of the frame, deg

    @property
    def phi(self) -> float:
        return norm_deg(self.base_phi + self.yaw_offset)


@dataclass
class Prop:
    name: str
    parent: str = MAP                    # "map" or another prop's name
    px: float = 0.0                      # pose relative to parent frame
    py: float = 0.0
    pz: float = 0.0
    pyaw: float = 0.0                    # deg
    covar: dict = field(default_factory=lambda: {"x": 1.0, "y": 1.0, "z": 1.0, "yaw": 1.0})
    lock_orientation: bool = False       # -> lock_orientation_to_config
    point_yaw_at_parent: bool = False
    cls: str | None = None               # -> class
    locked: bool = False                 # immovable + click-through in the view
    hidden: bool = False                 # hidden from the view
    # visualization only (not part of the ROS config)
    length: float = 0.6                  # footprint extent along forward (+X), m
    width: float = 0.6                   # footprint extent across (+Y), m
    color: str = ""
    image_path: str | None = None
    image_rot: float = 0.0
    # mesh footprint bbox in model coords (xmin, xmax, ymin, ymax); origin at model 0,0
    img_bbox: tuple | None = None

    def __post_init__(self):
        if not self.color:
            self.color = _color_for(self.name)

    def local_rect(self) -> tuple[float, float, float, float]:
        """Footprint rect (rx, ry, w, h) in item-local coords (+X forward, +Y down).

        Uses the mesh bbox when present so the model origin lands on the prop position,
        otherwise a symmetric rect from length/width.
        """
        if self.img_bbox:
            x0, x1, y0, y1 = self.img_bbox
            return (x0, -y1, x1 - x0, y1 - y0)   # local y = -(model y): +Y up in world
        return (-self.length / 2.0, -self.width / 2.0, self.length, self.width)


def _color_for(name: str) -> str:
    """Stable pleasant color from a name."""
    h = int(hashlib.md5(name.encode()).hexdigest(), 16)
    hue = h % 360
    return QColor.fromHsv(hue, 150, 200).name()


# tag frame (== map frame) <-> pool world -------------------------------

def world_to_map(px: float, py: float, pyaw: float, tag: Tag) -> tuple[float, float, float]:
    """Pool world pose -> map/AprilTag frame pose (REP-103)."""
    phi = math.radians(tag.phi)
    c, s = math.cos(phi), math.sin(phi)
    dx, dy = px - tag.x, py - tag.y
    return dx * c + dy * s, -dx * s + dy * c, norm_deg(pyaw - tag.phi)


def map_to_world(xr: float, yr: float, yawr: float, tag: Tag) -> tuple[float, float, float]:
    """Map/AprilTag frame pose -> pool world pose (REP-103)."""
    phi = math.radians(tag.phi)
    c, s = math.cos(phi), math.sin(phi)
    return tag.x + xr * c - yr * s, tag.y + xr * s + yr * c, norm_deg(yawr + tag.phi)


def tag_candidates(short_show, short_count, short_spacing,
                   long_show, long_count, long_spacing) -> list[dict]:
    cands: list[dict] = []
    if short_show:
        for x in centered_positions(POOL_LENGTH_M, short_count, short_spacing):
            if -0.01 <= x <= POOL_LENGTH_M + 0.01:
                cands.append({"x": x, "y": 0.0, "phi": 90.0, "wall": "S"})
                cands.append({"x": x, "y": POOL_WIDTH_M, "phi": 270.0, "wall": "N"})
    if long_show:
        for y in centered_positions(POOL_WIDTH_M, long_count, long_spacing):
            if -0.01 <= y <= POOL_WIDTH_M + 0.01:
                cands.append({"x": 0.0, "y": y, "phi": 0.0, "wall": "W"})
                cands.append({"x": POOL_LENGTH_M, "y": y, "phi": 180.0, "wall": "E"})
    return cands


# ----------------------------- mesh -> top-down image -----------------------------

CONFIG_PATH_DEFAULT = "/home/ubuntu/osu-uwrt/release/src/riptide_perception/riptide_mapping/config/config.yaml"
MESH_ROOT_DEFAULT = "/home/ubuntu/osu-uwrt/release/src/riptide_gui/riptide_meshes/meshes"

# config object name -> mesh directory, for the cases plain/suffix matching can't resolve.
MESH_ALIASES = {
    "slalom_parent": "slalom",
    "magnet1": "bin_magnet", "magnet2": "bin_magnet",
    "magnet_target1": "bin_magnet", "magnet_target2": "bin_magnet",
}


def _cache_dir() -> Path:
    d = Path.home() / ".cache" / "dead_reckoning" / "topdown"
    d.mkdir(parents=True, exist_ok=True)
    return d


def resolve_mesh_dir(name: str, mesh_root: Path) -> Path | None:
    """Best-effort map from a config object name to a riptide_meshes model directory."""
    if not mesh_root.exists():
        return None
    dirs = {p.name: p for p in mesh_root.iterdir() if p.is_dir() and (p / "model.dae").exists()}
    if name in MESH_ALIASES and MESH_ALIASES[name] in dirs:
        return dirs[MESH_ALIASES[name]]
    if name in dirs:
        return dirs[name]
    stripped = name.rstrip("0123456789")            # bin_vinyl1 -> bin_vinyl
    if stripped in dirs:
        return dirs[stripped]
    suffix = [k for k in dirs if k.endswith("_" + name)]  # pill -> table_pill, buoy -> octagon_buoy
    if len(suffix) == 1:
        return dirs[suffix[0]]
    return None


def render_dae_topdown(dae_path: Path, out_png: Path) -> tuple | None:
    """Render a model.dae to a transparent top-down PNG (+X right, +Y up, origin at model 0,0).

    Returns the model XY bounding box (xmin, xmax, ymin, ymax) in meters, or None on failure.
    Heavy deps (trimesh/matplotlib) are imported lazily so the app runs without them.
    """
    try:
        import numpy as np
        import trimesh
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        from matplotlib.collections import PolyCollection
    except Exception:
        return None

    def face_colors(geom):
        vis = geom.visual
        try:
            if isinstance(vis, trimesh.visual.TextureVisuals):
                fc = np.asarray(vis.to_color().face_colors)
            else:
                fc = np.asarray(vis.face_colors)
            if fc.ndim == 2 and fc.shape[0] == len(geom.faces):
                return fc
        except Exception:
            pass
        try:
            d = np.asarray(geom.visual.material.diffuse, dtype=float)
            if d.max() <= 1.0:
                d = d * 255.0
            return np.tile(d[:4].astype(np.uint8), (len(geom.faces), 1))
        except Exception:
            return np.tile([160, 160, 170, 255], (len(geom.faces), 1))

    try:
        scene = trimesh.load(str(dae_path))
        if isinstance(scene, trimesh.Trimesh):
            scene = trimesh.Scene(scene)
        polys, cols, zs = [], [], []
        for node in scene.graph.nodes_geometry:
            T, gname = scene.graph[node]
            geom = scene.geometry[gname]
            if not hasattr(geom, "faces") or len(geom.faces) == 0:
                continue
            V = trimesh.transformations.transform_points(geom.vertices, T)
            tri = V[geom.faces]
            polys.append(tri[:, :, :2])
            cols.append(face_colors(geom).astype(float) / 255.0)
            zs.append(tri[:, :, 2].mean(axis=1))
        if not polys:
            return None
        P = np.concatenate(polys)
        C = np.clip(np.concatenate(cols), 0, 1)
        Z = np.concatenate(zs)
        allxy = P.reshape(-1, 2)
        xmin, xmax = float(allxy[:, 0].min()), float(allxy[:, 0].max())
        ymin, ymax = float(allxy[:, 1].min()), float(allxy[:, 1].max())
        w = max(xmax - xmin, 0.02)
        h = max(ymax - ymin, 0.02)
        order = np.argsort(Z)                       # low Z first, top surfaces last
        fig = plt.figure(figsize=(4 * w / max(w, h), 4 * h / max(w, h)), dpi=140)
        ax = fig.add_axes([0, 0, 1, 1])
        ax.set_xlim(xmin, xmax)
        ax.set_ylim(ymin, ymax)                     # +Y up
        ax.set_aspect("equal")
        ax.axis("off")
        ax.add_collection(PolyCollection(P[order], facecolors=C[order], edgecolors="none"))
        out_png.parent.mkdir(parents=True, exist_ok=True)
        fig.savefig(str(out_png), transparent=True)
        plt.close(fig)
        return (xmin, xmax, ymin, ymax)
    except Exception:
        return None


def ensure_topdown(mesh_dir: Path) -> tuple | None:
    """Return (png_path, bbox) for a mesh dir, rendering + caching by dae mtime as needed."""
    dae = mesh_dir / "model.dae"
    if not dae.exists():
        return None
    cache = _cache_dir()
    png = cache / f"{mesh_dir.name}.png"
    meta = cache / f"{mesh_dir.name}.json"
    if png.exists() and meta.exists() and png.stat().st_mtime >= dae.stat().st_mtime:
        try:
            bbox = tuple(json.loads(meta.read_text())["bbox"])
            return (str(png), bbox)
        except Exception:
            pass
    bbox = render_dae_topdown(dae, png)
    if bbox is None:
        return None
    meta.write_text(json.dumps({"bbox": list(bbox)}))
    return (str(png), bbox)


# ----------------------------- graphics items -----------------------------

class PropItem(QGraphicsObject):
    """Draggable, rotatable footprint for one prop. Scene units are meters."""

    HANDLE_GAP = 0.45
    HANDLE_R = 0.22

    def __init__(self, prop: Prop, owner: "MainWindow") -> None:
        super().__init__()
        self.prop = prop
        self.owner = owner
        self._updating = False
        self._rotating = False
        self._is_child = False
        self._pixmap: QPixmap | None = None
        self.label = QGraphicsSimpleTextItem()
        self.label.setZValue(Z_LABEL)
        self.label.setBrush(QBrush(QColor("#111111")))
        # Constant on-screen size regardless of zoom (otherwise labels balloon when zoomed in).
        self.label.setFlag(QGraphicsItem.ItemIgnoresTransformations, True)
        f = QFont()
        f.setPixelSize(11)
        self.label.setFont(f)

        self.setFlag(QGraphicsItem.ItemIsMovable, True)
        self.setFlag(QGraphicsItem.ItemIsSelectable, True)
        self.setFlag(QGraphicsItem.ItemSendsGeometryChanges, True)
        self.setAcceptHoverEvents(True)
        self.reload_visuals()
        self.apply_lock()

    def _rect(self) -> QRectF:
        rx, ry, w, h = self.prop.local_rect()
        return QRectF(rx, ry, w, h)

    def boundingRect(self) -> QRectF:
        r = self._rect()
        return r.adjusted(-0.3, -0.3, self.HANDLE_GAP + self.HANDLE_R + 0.3, 0.3)

    def shape(self) -> QPainterPath:
        # Tight hit region = footprint (+ rotate handle when selected), so a click just off a
        # prop counts as background and pans the view instead of grabbing the prop.
        path = QPainterPath()
        path.addRect(self._rect())
        if self.isSelected() and not self.prop.locked:
            h = self._handle_local()
            path.addEllipse(h, self.HANDLE_R, self.HANDLE_R)
        return path

    def apply_lock(self) -> None:
        locked = self.prop.locked
        self.setFlag(QGraphicsItem.ItemIsMovable, not locked)
        # NoButton -> clicks pass through to props on top (e.g. items sitting on the table),
        # but the item stays programmatically selectable from the tree/table for editing/unlocking.
        self.setAcceptedMouseButtons(Qt.NoButton if locked else Qt.AllButtons)
        self.setAcceptHoverEvents(not locked)

    def set_world_pose(self, wx: float, wy: float, wyaw: float) -> None:
        # Hot path (called per drag move): no prepareGeometryChange/update — setPos and
        # setRotation already schedule the needed repaint, and the bounding rect is unchanged.
        self._updating = True
        self.setPos(wx, POOL_WIDTH_M - wy)
        self.setRotation(-wyaw)
        self.setZValue(Z_LOCKED if self.prop.locked else Z_PROP)
        self._updating = False
        if self.label.text() != self.prop.name:
            self.label.setText(self.prop.name)
        # Anchor at the prop origin; center + drop a few pixels below (device-space, zoom-independent).
        self.label.setPos(self.pos())
        self.label.setTransform(QTransform().translate(-self.label.boundingRect().width() / 2.0, 6.0))

    def reload_visuals(self) -> None:
        self._pixmap = None
        if self.prop.image_path:
            raw = QPixmap(self.prop.image_path)
            if not raw.isNull():
                # Rendered top-down PNGs are already +X-right / +Y-up; image_rot fine-tunes.
                self._pixmap = (raw if not self.prop.image_rot else
                                raw.transformed(QTransform().rotate(self.prop.image_rot),
                                                Qt.SmoothTransformation))
        self.prepareGeometryChange()
        self.update()

    def paint(self, painter: QPainter, option, widget=None) -> None:
        rect = self._rect()
        base = QColor(self.prop.color)

        if self._pixmap is not None:
            painter.drawPixmap(rect, self._pixmap, QRectF(self._pixmap.rect()))
            painter.setPen(QPen(base.darker(140), 0.02))
            painter.setBrush(Qt.NoBrush)
            painter.drawRect(rect)
        else:
            fill = QColor(base)
            fill.setAlpha(90 if self.prop.locked else 150)
            painter.setBrush(QBrush(fill))
            painter.setPen(QPen(base.darker(160), 0.03))
            painter.drawRect(rect)

        # forward marker at the pose point (model origin)
        painter.setBrush(QBrush(QColor("#111111")))
        painter.setPen(Qt.NoPen)
        s = max(0.06, min(0.18, 0.25 * min(rect.width(), rect.height())))
        painter.drawPolygon(QPolygonF([QPointF(0.0, -s), QPointF(0.0, s), QPointF(2 * s, 0.0)]))

        if self.isSelected():
            painter.setPen(QPen(QColor("#1f6feb"), 0.05, Qt.DashLine))
            painter.setBrush(Qt.NoBrush)
            painter.drawRect(rect.adjusted(-0.08, -0.08, 0.08, 0.08))
            if not self.prop.locked:
                hx = rect.right() + self.HANDLE_GAP
                painter.setPen(QPen(QColor("#1f6feb"), 0.04))
                painter.drawLine(QPointF(rect.right(), 0.0), QPointF(hx, 0.0))
                painter.setBrush(QBrush(QColor("#1f6feb")))
                painter.setPen(Qt.NoPen)
                painter.drawEllipse(QPointF(hx, 0.0), self.HANDLE_R, self.HANDLE_R)

    def _handle_local(self) -> QPointF:
        return QPointF(self._rect().right() + self.HANDLE_GAP, 0.0)

    def _near_handle(self, local_pt: QPointF) -> bool:
        d = local_pt - self._handle_local()
        return math.hypot(d.x(), d.y()) <= self.HANDLE_R * 1.8

    def hoverMoveEvent(self, event) -> None:
        self.setCursor(Qt.CrossCursor if (self.isSelected() and self._near_handle(event.pos()))
                       else Qt.OpenHandCursor)
        super().hoverMoveEvent(event)

    def mousePressEvent(self, event) -> None:
        if event.button() == Qt.LeftButton and self.isSelected() and self._near_handle(event.pos()):
            self._rotating = True
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event) -> None:
        if self._rotating:
            v = event.scenePos() - self.scenePos()
            wyaw = norm_deg(math.degrees(math.atan2(-v.y(), v.x())))
            self.owner.on_item_rotated(self, wyaw)
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event) -> None:
        self._rotating = False
        super().mouseReleaseEvent(event)

    def itemChange(self, change, value):
        if change == QGraphicsItem.ItemPositionChange and not self._updating:
            x = min(max(value.x(), -2.0), POOL_LENGTH_M + 2.0)
            y = min(max(value.y(), -2.0), POOL_WIDTH_M + 2.0)
            value = QPointF(x, y)
        if change == QGraphicsItem.ItemPositionHasChanged and not self._updating:
            wx, wy = scene_to_world(value.x(), value.y())
            self.owner.on_item_dragged(self, wx, wy)
        if change == QGraphicsItem.ItemSelectedHasChanged:
            self.owner.on_selection_changed()
        return super().itemChange(change, value)


class PoolView(QGraphicsView):
    mouseSceneMoved = Signal(QPointF)
    tagPointPicked = Signal(QPointF)

    def __init__(self, scene: QGraphicsScene) -> None:
        super().__init__(scene)
        self.setRenderHint(QPainter.Antialiasing, True)
        self.setMouseTracking(True)
        self.setDragMode(QGraphicsView.NoDrag)
        self.setTransformationAnchor(QGraphicsView.AnchorUnderMouse)
        self.setBackgroundBrush(QBrush(QColor("#eef1f4")))
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        self.set_tag_mode = False
        self._panning = False
        self._pan_start = QPointF()

    def enter_tag_mode(self, on: bool) -> None:
        self.set_tag_mode = on
        self.setCursor(Qt.CrossCursor if on else Qt.ArrowCursor)

    def _limit_rect(self) -> QRectF:
        """Largest area the user may zoom out to: pool + margin, unioned with all props."""
        m = 3.0
        rect = QRectF(-m, -m, POOL_LENGTH_M + 2 * m, POOL_WIDTH_M + 2 * m)
        for it in self.scene().items():
            if isinstance(it, PropItem) and it.isVisible():
                rect = rect.united(it.sceneBoundingRect())
        return rect

    def _min_scale(self) -> float:
        rect = self._limit_rect()
        vp = self.viewport().rect()
        if rect.width() <= 0 or rect.height() <= 0:
            return 1e-6
        return min(vp.width() / rect.width(), vp.height() / rect.height())

    def wheelEvent(self, event):  # type: ignore[override]
        factor = 1.15 if event.angleDelta().y() > 0 else 1.0 / 1.15
        if factor < 1.0:                       # zooming out — don't go past the limit rect
            cur = self.transform().m11()
            min_s = self._min_scale()
            if cur * factor < min_s:
                factor = min_s / cur
                if factor >= 1.0:              # already at/beyond the limit
                    return
        self.scale(factor, factor)

    def _interactive_prop_at(self, view_pos) -> bool:
        """True if an unlocked, visible prop is under the cursor (so left-drag should move it)."""
        for it in self.items(view_pos):
            if isinstance(it, PropItem) and it.isVisible() and (it.acceptedMouseButtons() & Qt.LeftButton):
                return True
        return False

    def _start_pan(self, event) -> None:
        self._panning = True
        self._pan_start = event.position()
        self.setCursor(Qt.ClosedHandCursor)
        event.accept()

    def mousePressEvent(self, event):  # type: ignore[override]
        if self.set_tag_mode and event.button() == Qt.LeftButton:
            self.tagPointPicked.emit(self.mapToScene(event.position().toPoint()))
            self.enter_tag_mode(False)
            event.accept()
            return
        if event.button() == Qt.MiddleButton:
            self._start_pan(event)
            return
        if event.button() == Qt.LeftButton and not self._interactive_prop_at(event.position().toPoint()):
            # empty background (or a locked prop) -> deselect, then pan with the drag
            self.scene().clearSelection()
            self._start_pan(event)
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event):  # type: ignore[override]
        if self._panning:
            delta = event.position() - self._pan_start
            self._pan_start = event.position()
            self.horizontalScrollBar().setValue(self.horizontalScrollBar().value() - int(delta.x()))
            self.verticalScrollBar().setValue(self.verticalScrollBar().value() - int(delta.y()))
            event.accept()
            return
        self.mouseSceneMoved.emit(self.mapToScene(event.position().toPoint()))
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event):  # type: ignore[override]
        if self._panning and event.button() in (Qt.MiddleButton, Qt.LeftButton):
            self._panning = False
            self.setCursor(Qt.CrossCursor if self.set_tag_mode else Qt.ArrowCursor)
            event.accept()
            return
        super().mouseReleaseEvent(event)

    def fit_all(self) -> None:
        self.fitInView(QRectF(-2, -2, POOL_LENGTH_M + 4, POOL_WIDTH_M + 4), Qt.KeepAspectRatio)


# ----------------------------- inspector widgets -----------------------------

class Card(QFrame):
    """A titled white rounded panel for the inspector."""

    def __init__(self, title: str = "", parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setObjectName("card")
        outer = QVBoxLayout(self)
        outer.setContentsMargins(14, 12, 14, 14)
        outer.setSpacing(10)
        if title:
            head = QLabel(title)
            head.setObjectName("cardTitle")
            outer.addWidget(head)
        self.body = QVBoxLayout()
        self.body.setSpacing(8)
        outer.addLayout(self.body)

    def add(self, w) -> None:
        if isinstance(w, QWidget):
            self.body.addWidget(w)
        else:
            self.body.addLayout(w)


class Collapsible(QWidget):
    """A section with a clickable header that expands/collapses its content."""

    def __init__(self, title: str, expanded: bool = False, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        v = QVBoxLayout(self)
        v.setContentsMargins(0, 0, 0, 0)
        v.setSpacing(4)
        self._title = title
        self._btn = QPushButton()
        self._btn.setObjectName("chevron")
        self._btn.setCursor(Qt.PointingHandCursor)
        self._btn.setText(("▾  " if expanded else "▸  ") + title.replace("&", "&&"))
        self._content = QWidget()
        self.content = QVBoxLayout(self._content)
        self.content.setContentsMargins(2, 2, 2, 2)
        self.content.setSpacing(8)
        self._content.setVisible(expanded)
        self._btn.clicked.connect(self._toggle)
        v.addWidget(self._btn)
        v.addWidget(self._content)

    def _toggle(self) -> None:
        vis = not self._content.isVisible()
        self._content.setVisible(vis)
        self._btn.setText(("▾  " if vis else "▸  ") + self._title.replace("&", "&&"))

    def add(self, w) -> None:
        if isinstance(w, QWidget):
            self.content.addWidget(w)
        else:
            self.content.addLayout(w)


# ----------------------------- main window -----------------------------

class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("RoboSub 2026 Dead Reckoning — Woollett Pool")
        self.resize(1550, 900)

        self.tag: Tag | None = None
        self.props: list[Prop] = []
        self.items_by_name: dict[str, PropItem] = {}
        self._map_pose: dict[str, tuple] = {}
        self._static_items: list[QGraphicsItem] = []
        self._tag_items: list[QGraphicsItem] = []
        self._loading_panel = False
        self._syncing_selection = False
        self._selected_name: str | None = None
        self._tree_items: dict[str, QTreeWidgetItem] = {}
        # loaded-config round-trip state
        self._doc = None
        self._ns = None
        self._config_path: Path | None = None

        self.scene = QGraphicsScene(self)
        self.scene.setSceneRect(-3, -3, POOL_LENGTH_M + 6, POOL_WIDTH_M + 6)
        self.view = PoolView(self.scene)
        self.view.mouseSceneMoved.connect(self._on_mouse_moved)
        self.view.tagPointPicked.connect(self._on_tag_point_picked)

        self._build_ui()
        self._build_menu()

        self.rebuild_static()
        self._set_default_tag()
        if Path(CONFIG_PATH_DEFAULT).exists():
            self._load_config_path(CONFIG_PATH_DEFAULT, auto=True)
        else:
            self._add_placeholder_props()
        self.reflow()
        self.rebuild_tree()
        self.refresh_all()

        self.statusBar().showMessage(
            "Set the AprilTag, then drag props (blue knob = rotate) or type poses. "
            "Left/middle-drag pans, wheel zooms.")
        from PySide6.QtCore import QTimer
        # Fit once the window has a real size (a fit during __init__ runs before layout).
        QTimer.singleShot(0, self.view.fit_all)
        # Populate top-down mesh images after the window is shown (cached after first run).
        if Path(MESH_ROOT_DEFAULT).exists():
            QTimer.singleShot(60, self._auto_assign_meshes)

    # ------------------------- UI -------------------------
    def _build_ui(self) -> None:
        self.addToolBar(self._build_toolbar())
        left = QSplitter(Qt.Vertical)
        left.addWidget(self._build_inspector())
        left.addWidget(self._build_objects_panel())
        left.setStretchFactor(0, 3)
        left.setStretchFactor(1, 2)
        left.setSizes([560, 360])
        left.setChildrenCollapsible(False)

        main = QSplitter(Qt.Horizontal)
        main.addWidget(left)
        main.addWidget(self.view)
        main.setStretchFactor(0, 0)
        main.setStretchFactor(1, 1)
        main.setSizes([380, 1140])
        main.setChildrenCollapsible(False)

        wrap = QWidget()
        wrap.setObjectName("central")
        lay = QHBoxLayout(wrap)
        lay.setContentsMargins(10, 8, 10, 8)
        lay.addWidget(main)
        self.setCentralWidget(wrap)

    # small builders ---------------------------------------------------------
    def _toolbtn(self, text, slot, name="", tooltip="", checkable=False) -> QPushButton:
        b = QPushButton(text)
        if name:
            b.setObjectName(name)
        if tooltip:
            b.setToolTip(tooltip)
        b.setCheckable(checkable)
        b.setCursor(Qt.PointingHandCursor)
        b.clicked.connect(slot)
        return b

    def _sep(self) -> QFrame:
        line = QFrame()
        line.setFrameShape(QFrame.VLine)
        line.setStyleSheet("color:#dde1e7;")
        line.setFixedWidth(1)
        return line

    def _scroll(self, inner: QWidget) -> QScrollArea:
        s = QScrollArea()
        s.setWidgetResizable(True)
        s.setFrameShape(QFrame.NoFrame)
        s.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        s.setWidget(inner)
        return s

    def _build_toolbar(self) -> QToolBar:
        tb = QToolBar()
        tb.setObjectName("topbar")
        tb.setMovable(False)
        title = QLabel("Dead Reckoning")
        title.setObjectName("appTitle")
        tb.addWidget(title)
        self.set_tag_btn = self._toolbtn(
            "◎  Set AprilTag", self._on_set_tag_clicked, "accent",
            "Click, then pick a bottom-line / wall intersection in the pool", checkable=True)
        tb.addWidget(self.set_tag_btn)
        tb.addWidget(self._sep())
        tb.addWidget(self._toolbtn("Load config", self._load_config,
                                   tooltip="Open a riptide_mapping config.yaml"))
        tb.addWidget(self._toolbtn("Save config", self._save_config,
                                   tooltip="Write the mapping config back out"))
        tb.addWidget(self._toolbtn("Load meshes", self._auto_assign_meshes,
                                   tooltip="Render top-down images from riptide_meshes"))
        tb.addWidget(self._toolbtn("Export CSV", self._export_csv))
        spacer = QWidget()
        spacer.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Preferred)
        tb.addWidget(spacer)
        tb.addWidget(self._toolbtn("Fit view", self.view.fit_all, "ghost"))
        return tb

    def _build_inspector(self) -> QWidget:
        inner = QWidget()
        col = QVBoxLayout(inner)
        col.setContentsMargins(0, 0, 8, 0)
        col.setSpacing(10)

        # AprilTag -----------------------------------------------------------
        tag = Card("AprilTag origin — map (0,0)")
        self.tag_status = QLabel()
        self.tag_status.setObjectName("mono")
        self.tag_status.setWordWrap(True)
        tag.add(self.tag_status)
        rot = QHBoxLayout()
        rot.addWidget(self._toolbtn("⟲  +90°", lambda: self._nudge_tag_offset(90.0)))
        rot.addWidget(self._toolbtn("⟳  −90°", lambda: self._nudge_tag_offset(-90.0)))
        tag.add(rot)
        off = QFormLayout()
        off.setContentsMargins(0, 0, 0, 0)
        self.tag_offset = self._dspin(-180, 180, 0.0, 1.0, 1, self._on_tag_offset_changed, " °")
        off.addRow("Yaw fine-tune", self.tag_offset)
        tag.add(off)
        col.addWidget(tag)

        # Selected object ----------------------------------------------------
        sel = Card("Selected object")
        head = QHBoxLayout()
        self.r_name = QLabel("— none —")
        self.r_name.setObjectName("sel")
        self.r_parent = QLabel("")
        self.r_parent.setObjectName("muted")
        head.addWidget(self.r_name)
        head.addStretch(1)
        head.addWidget(self.r_parent)
        sel.add(head)

        sub = QLabel("Pose relative to parent  (= config numbers)")
        sub.setObjectName("muted")
        sel.add(sub)

        grid = QGridLayout()
        grid.setHorizontalSpacing(8)
        grid.setVerticalSpacing(6)
        self.r_x = self._dspin(-100, 100, 0.0, 0.01, 3, self._apply_rel_to_prop, " m")
        self.r_y = self._dspin(-100, 100, 0.0, 0.01, 3, self._apply_rel_to_prop, " m")
        self.r_z = self._dspin(-20, 10, 0.0, 0.01, 3, self._apply_rel_to_prop, " m")
        self.r_yaw = self._dspin(-180, 180, 0.0, 0.5, 2, self._apply_rel_to_prop, " °")
        for i, (lbl, wdg) in enumerate((("x", self.r_x), ("y", self.r_y),
                                        ("z", self.r_z), ("yaw", self.r_yaw))):
            rr, cc = divmod(i, 2)
            lw = QLabel(lbl)
            lw.setObjectName("muted")
            grid.addWidget(lw, rr, cc * 2)
            grid.addWidget(wdg, rr, cc * 2 + 1)
        grid.setColumnStretch(1, 1)
        grid.setColumnStretch(3, 1)
        sel.add(grid)

        toggles = QHBoxLayout()
        self.r_lock = QCheckBox("Lock")
        self.r_lock.setToolTip("Immovable + click-through in the view")
        self.r_lock.stateChanged.connect(lambda _=0: self._toggle_lock(self.r_lock.isChecked()))
        self.r_hide = QCheckBox("Hide")
        self.r_hide.setToolTip("Hide this prop from the view")
        self.r_hide.stateChanged.connect(lambda _=0: self._toggle_hide(self.r_hide.isChecked()))
        toggles.addWidget(self.r_lock)
        toggles.addWidget(self.r_hide)
        toggles.addStretch(1)
        sel.add(toggles)

        self.r_world = QLabel("")
        self.r_world.setObjectName("mono")
        self.r_world.setWordWrap(True)
        sel.add(self.r_world)

        adv = Collapsible("Appearance & advanced", expanded=False)
        af = QFormLayout()
        af.setContentsMargins(0, 0, 0, 0)
        af.setSpacing(8)
        self.e_name = QLineEdit()
        self.e_name.editingFinished.connect(self._rename_selected)
        af.addRow("Name", self.e_name)
        self.e_parent = QComboBox()
        self.e_parent.activated.connect(self._reparent_selected)
        af.addRow("Parent", self.e_parent)
        fp = QHBoxLayout()
        self.e_len = self._dspin(0.02, 30, 0.6, 0.05, 2, self._apply_edit, " m")
        self.e_wid = self._dspin(0.02, 30, 0.6, 0.05, 2, self._apply_edit, " m")
        fp.addWidget(self.e_len)
        fp.addWidget(QLabel("×"))
        fp.addWidget(self.e_wid)
        af.addRow("Footprint L×W", fp)
        appr = QHBoxLayout()
        self.e_color = self._toolbtn("Color", self._pick_color)
        self.e_img = self._toolbtn("Image…", self._pick_image)
        self.e_imgx = self._toolbtn("✕", self._clear_image)
        self.e_imgx.setMaximumWidth(32)
        self.e_mesh = self._toolbtn("Mesh", self._assign_mesh_selected,
                                    tooltip="Assign top-down mesh image by name")
        appr.addWidget(self.e_color)
        appr.addWidget(self.e_img)
        appr.addWidget(self.e_imgx)
        appr.addWidget(self.e_mesh)
        af.addRow("Appearance", appr)
        self.e_imgrot = self._dspin(-180, 180, 0.0, 5.0, 1, self._apply_edit, " °")
        af.addRow("Image rotation", self.e_imgrot)
        self.e_class = QLineEdit()
        self.e_class.setPlaceholderText("(none)")
        self.e_class.editingFinished.connect(self._apply_edit)
        af.addRow("class", self.e_class)
        self.e_lock = QCheckBox("lock_orientation_to_config")
        self.e_lock.stateChanged.connect(lambda _=0: self._apply_edit())
        af.addRow("", self.e_lock)
        self.e_point = QCheckBox("point_yaw_at_parent")
        self.e_point.stateChanged.connect(lambda _=0: self._apply_edit())
        af.addRow("", self.e_point)
        adv.add(af)
        covg = QGridLayout()
        covg.setHorizontalSpacing(8)
        covg.setVerticalSpacing(6)
        self.e_cov = {}
        for i, k in enumerate(("x", "y", "z", "yaw")):
            sp = self._dspin(0.0, 1000, 1.0, 0.001, 3, self._apply_edit)
            self.e_cov[k] = sp
            rr, cc = divmod(i, 2)
            lw = QLabel("cov " + k)
            lw.setObjectName("muted")
            covg.addWidget(lw, rr, cc * 2)
            covg.addWidget(sp, rr, cc * 2 + 1)
        covg.setColumnStretch(1, 1)
        covg.setColumnStretch(3, 1)
        adv.add(covg)
        sel.add(adv)
        col.addWidget(sel)

        # Pool & display -----------------------------------------------------
        pool = Collapsible("Pool & display", expanded=False)
        pf = QFormLayout()
        pf.setContentsMargins(0, 0, 0, 0)
        pf.setSpacing(8)
        self.short_show = self._checkbox(True, self.rebuild_static_and_refresh)
        self.short_count = self._spin(1, 64, 17, self.rebuild_static_and_refresh)
        self.short_spacing = self._dspin(0.25, 5, DEFAULT_NINE_FT_M, 0.001, 3, self.rebuild_static_and_refresh, " m")
        self.long_show = self._checkbox(True, self.rebuild_static_and_refresh)
        self.long_count = self._spin(1, 64, 8, self.rebuild_static_and_refresh)
        self.long_spacing = self._dspin(0.25, 5, DEFAULT_NINE_FT_M, 0.001, 3, self.rebuild_static_and_refresh, " m")
        self.show_grid = self._checkbox(True, self.rebuild_static_and_refresh)
        self.show_children = self._checkbox(True, self._toggle_children)
        pf.addRow("Short-side lines", self.short_show)
        pf.addRow("  count", self.short_count)
        pf.addRow("  spacing", self.short_spacing)
        pf.addRow("Long-side lines", self.long_show)
        pf.addRow("  count", self.long_count)
        pf.addRow("  spacing", self.long_spacing)
        pf.addRow("5 m grid", self.show_grid)
        pf.addRow("Show child props", self.show_children)
        pool.add(pf)
        col.addWidget(pool)
        col.addStretch(1)
        return self._scroll(inner)

    def _build_objects_panel(self) -> QWidget:
        panel = QWidget()
        v = QVBoxLayout(panel)
        v.setContentsMargins(0, 6, 0, 0)
        v.setSpacing(6)
        head = QHBoxLayout()
        t = QLabel("Objects")
        t.setObjectName("cardTitle")
        head.addWidget(t)
        head.addStretch(1)
        head.addWidget(self._toolbtn("+ Add", self._add_prop_clicked, "ghost"))
        head.addWidget(self._toolbtn("Duplicate", self._duplicate_selected, "ghost"))
        head.addWidget(self._toolbtn("Delete", self._delete_selected, "ghost"))
        v.addLayout(head)
        self.tree = QTreeWidget()
        self.tree.setHeaderLabels(["Object", "\U0001f512", "\U0001f6ab", "x", "y", "z", "yaw"])
        self.tree.setAlternatingRowColors(True)
        self.tree.setUniformRowHeights(True)
        self.tree.setToolTip("\U0001f512 lock in place (immovable + click-through)   "
                             "\U0001f6ab hide from the view")
        h = self.tree.header()
        h.setSectionResizeMode(0, QHeaderView.Stretch)
        for c in (TABLE_LOCK_COL, TABLE_HIDE_COL):
            h.setSectionResizeMode(c, QHeaderView.Fixed)
            self.tree.setColumnWidth(c, 30)
        for c in TREE_POSE_COLS:
            h.setSectionResizeMode(c, QHeaderView.ResizeToContents)
        self.tree.itemSelectionChanged.connect(self._on_tree_selection)
        self.tree.itemChanged.connect(self._on_tree_item_changed)
        v.addWidget(self.tree)
        return panel

    def _build_menu(self) -> None:
        m = self.menuBar().addMenu("File")
        a_load = QAction("Load mapping config…", self)
        a_load.setShortcut(QKeySequence("Ctrl+O"))
        a_load.triggered.connect(self._load_config)
        m.addAction(a_load)
        a_save = QAction("Save mapping config…", self)
        a_save.setShortcut(QKeySequence("Ctrl+S"))
        a_save.triggered.connect(self._save_config)
        m.addAction(a_save)
        a_csv = QAction("Export CSV…", self)
        a_csv.triggered.connect(self._export_csv)
        m.addAction(a_csv)
        m.addSeparator()
        a_quit = QAction("Quit", self)
        a_quit.setShortcut(QKeySequence.Quit)
        a_quit.triggered.connect(self.close)
        m.addAction(a_quit)

    # widget factories
    def _checkbox(self, checked, slot):
        c = QCheckBox()
        c.setChecked(checked)
        c.stateChanged.connect(lambda _=0: slot())
        return c

    def _spin(self, lo, hi, val, slot):
        s = QSpinBox()
        s.setRange(lo, hi)
        s.setValue(val)
        s.valueChanged.connect(lambda _=0: slot())
        return s

    def _dspin(self, lo, hi, val, step, dec, slot, suffix=""):
        s = QDoubleSpinBox()
        s.setRange(lo, hi)
        s.setDecimals(dec)
        s.setSingleStep(step)
        s.setValue(val)
        if suffix:
            s.setSuffix(suffix)
        s.valueChanged.connect(lambda _=0: slot())
        return s

    # ------------------------- static geometry -------------------------
    def _clear_items(self, items: list) -> None:
        for it in items:
            self.scene.removeItem(it)
        items.clear()

    def rebuild_static_and_refresh(self) -> None:
        self.rebuild_static()
        self.rebuild_tag_gizmo()
        self.refresh_all()

    def rebuild_static(self) -> None:
        self._clear_items(self._static_items)
        water = self.scene.addRect(0, 0, POOL_LENGTH_M, POOL_WIDTH_M,
                                   QPen(QColor("#0d3b66"), 0.08), QBrush(QColor("#d8f3ff")))
        water.setZValue(Z_WATER)
        self._static_items.append(water)

        if self.show_grid.isChecked():
            gpen = QPen(QColor(120, 120, 120, 90), 0.02, Qt.DashLine)
            x = 5.0
            while x < POOL_LENGTH_M:
                ln = self.scene.addLine(x, 0, x, POOL_WIDTH_M, gpen)
                ln.setZValue(Z_GRID)
                self._static_items.append(ln)
                x += 5.0
            y = 5.0
            while y < POOL_WIDTH_M:
                ln = self.scene.addLine(0, y, POOL_LENGTH_M, y, gpen)
                ln.setZValue(Z_GRID)
                self._static_items.append(ln)
                y += 5.0

        thickness = 10.0 / 12.0 * M_PER_FT
        if self.short_show.isChecked():
            length = max(1.0, POOL_WIDTH_M - 2.0)
            y0 = (POOL_WIDTH_M - length) / 2.0
            for x in centered_positions(POOL_LENGTH_M, self.short_count.value(), self.short_spacing.value()):
                r = self.scene.addRect(x - thickness / 2, POOL_WIDTH_M - (y0 + length), thickness, length,
                                       QPen(Qt.NoPen), QBrush(QColor("#20303a")))
                r.setZValue(Z_LINES)
                self._static_items.append(r)
        if self.long_show.isChecked():
            length = max(1.0, POOL_LENGTH_M - 4.0)
            x0 = (POOL_LENGTH_M - length) / 2.0
            for y in centered_positions(POOL_WIDTH_M, self.long_count.value(), self.long_spacing.value()):
                sy = POOL_WIDTH_M - y
                r = self.scene.addRect(x0, sy - thickness / 2, length, thickness,
                                       QPen(Qt.NoPen), QBrush(QColor("#0d3b66")))
                r.setZValue(Z_LINES)
                self._static_items.append(r)

    # ------------------------- tag -------------------------
    def _candidates(self) -> list[dict]:
        return tag_candidates(self.short_show.isChecked(), self.short_count.value(), self.short_spacing.value(),
                              self.long_show.isChecked(), self.long_count.value(), self.long_spacing.value())

    def _set_default_tag(self) -> None:
        cands = [c for c in self._candidates() if c["wall"] == "W"] or self._candidates()
        if not cands:
            return
        target = POOL_WIDTH_M / 2.0
        best = min(cands, key=lambda c: abs(c["y"] - target) + abs(c["x"]))
        self.tag = Tag(best["x"], best["y"], best["phi"], best["wall"])
        self.rebuild_tag_gizmo()

    def _on_tag_point_picked(self, scene_pt: QPointF) -> None:
        self.set_tag_btn.setChecked(False)
        wx, wy = scene_to_world(scene_pt.x(), scene_pt.y())
        cands = self._candidates()
        if not cands:
            QMessageBox.information(self, "No snap points",
                                    "Enable a line set (Pool & display) to create wall intersections.")
            return
        best = min(cands, key=lambda c: (c["x"] - wx) ** 2 + (c["y"] - wy) ** 2)
        if math.hypot(best["x"] - wx, best["y"] - wy) > 3.0:
            self.statusBar().showMessage("No line/wall point within 3 m of that click.")
            return
        off = self.tag.yaw_offset if self.tag else 0.0
        self.tag = Tag(best["x"], best["y"], best["phi"], best["wall"], yaw_offset=off)
        self.rebuild_tag_gizmo()
        self.reflow()
        self.refresh_all()

    def _on_tag_offset_changed(self) -> None:
        if self.tag:
            self.tag.yaw_offset = self.tag_offset.value()
            self.rebuild_tag_gizmo()
            self.reflow()
            self.refresh_all()

    def _nudge_tag_offset(self, delta: float) -> None:
        self.tag_offset.setValue(norm_deg(self.tag_offset.value() + delta))

    def rebuild_tag_gizmo(self) -> None:
        self._clear_items(self._tag_items)
        if not self.tag:
            return
        origin = world_to_scene(self.tag.x, self.tag.y)
        phi = math.radians(self.tag.phi)

        def axis(angle, color):
            end = QPointF(origin.x() + math.cos(angle) * 3.0, origin.y() - math.sin(angle) * 3.0)
            ln = self.scene.addLine(origin.x(), origin.y(), end.x(), end.y(), QPen(QColor(color), 0.09))
            ln.setZValue(Z_TAG)
            self._tag_items.append(ln)
            head = self.scene.addEllipse(end.x() - 0.14, end.y() - 0.14, 0.28, 0.28,
                                         QPen(Qt.NoPen), QBrush(QColor(color)))
            head.setZValue(Z_TAG)
            self._tag_items.append(head)

        axis(phi, "#d11")                    # +X into pool
        axis(phi + math.pi / 2, "#1a1")      # +Y left
        dot = self.scene.addEllipse(origin.x() - 0.25, origin.y() - 0.25, 0.5, 0.5,
                                    QPen(QColor("#111"), 0.05), QBrush(QColor("#111")))
        dot.setZValue(Z_TAG + 1)
        self._tag_items.append(dot)
        lbl = self.scene.addText("AprilTag = map (0,0)")
        lbl.setDefaultTextColor(QColor("#b00020"))
        lbl.setFlag(QGraphicsItem.ItemIgnoresTransformations, True)
        lf = QFont()
        lf.setPixelSize(11)
        lbl.setFont(lf)
        lbl.setPos(origin.x() + 0.3, origin.y() + 0.3)
        lbl.setZValue(Z_TAG + 1)
        self._tag_items.append(lbl)

    # ------------------------- prop bookkeeping -------------------------
    def _by_name(self) -> dict[str, Prop]:
        return {p.name: p for p in self.props}

    def _children_of(self, name: str) -> list[Prop]:
        return [p for p in self.props if p.parent == name]

    def _descendants(self, name: str) -> set[str]:
        out, stack = set(), [name]
        while stack:
            cur = stack.pop()
            for c in self._children_of(cur):
                if c.name not in out:
                    out.add(c.name)
                    stack.append(c.name)
        return out

    def _add_prop(self, prop: Prop, is_child: bool = False) -> PropItem:
        self.props.append(prop)
        item = PropItem(prop, self)
        item._is_child = is_child
        self.items_by_name[prop.name] = item
        self.scene.addItem(item)
        self.scene.addItem(item.label)
        return item

    def _add_placeholder_props(self) -> None:
        cx, cy = POOL_LENGTH_M / 2, POOL_WIDTH_M / 2
        for p in (Prop("gate", MAP, length=0.3, width=3.0),
                  Prop("buoy", MAP, length=0.4, width=0.4),
                  Prop("bin", MAP, length=1.2, width=0.9),
                  Prop("torpedo", MAP, length=1.0, width=1.0)):
            self._add_prop(p)
        # give them spread-out map poses via a temporary world placement
        spots = [(cx - 13, cy), (cx - 6, cy + 1.5), (cx + 2, cy - 3), (cx + 10, cy + 2)]
        for prop, (wx, wy) in zip(self.props, spots):
            mx, my, myaw = world_to_map(wx, wy, 0.0, self.tag)
            prop.px, prop.py, prop.pyaw = mx, my, myaw

    def _unique_name(self, base: str) -> str:
        names = {p.name for p in self.props}
        if base not in names:
            return base
        i = 2
        while f"{base}_{i}" in names:
            i += 1
        return f"{base}_{i}"

    def _add_prop_clicked(self) -> None:
        name = self._unique_name("prop")
        mx, my, myaw = world_to_map(POOL_LENGTH_M / 2, POOL_WIDTH_M / 2, 0.0, self.tag)
        p = Prop(name, MAP, mx, my, 0.0, myaw)
        self._add_prop(p)
        self.reflow()
        self.rebuild_tree()
        self._select_prop_by_name(name)
        self.refresh_all()

    def _duplicate_selected(self) -> None:
        src = self._selected_prop()
        if not src:
            return
        name = self._unique_name(src.name + "_copy")
        p = Prop(name=name, parent=src.parent, px=src.px + 0.5, py=src.py + 0.5, pz=src.pz,
                 pyaw=src.pyaw, covar=dict(src.covar), lock_orientation=src.lock_orientation,
                 point_yaw_at_parent=src.point_yaw_at_parent, cls=src.cls, locked=src.locked,
                 hidden=src.hidden, length=src.length, width=src.width, color=src.color,
                 image_path=src.image_path, image_rot=src.image_rot, img_bbox=src.img_bbox)
        self._add_prop(p, is_child=(src.parent != MAP))
        self.reflow()
        self.rebuild_tree()
        self._select_prop_by_name(name)
        self.refresh_all()

    def _delete_selected(self) -> None:
        prop = self._selected_prop()
        if not prop:
            return
        # re-parent children to map so we don't orphan them
        for c in self._children_of(prop.name):
            c.parent = MAP
        item = self.items_by_name.pop(prop.name)
        self.scene.removeItem(item.label)
        self.scene.removeItem(item)
        self.props.remove(prop)
        if self._selected_name == prop.name:
            self._selected_name = None
        self.reflow()
        self.rebuild_tree()
        self.refresh_all()

    # ------------------------- composition / reflow -------------------------
    def reflow(self) -> None:
        if not self.tag:
            return
        by = self._by_name()
        memo: dict[str, tuple] = {}

        def mp(name, visiting):
            if name in memo:
                return memo[name]
            p = by.get(name)
            if p is None or p.parent == MAP or p.parent not in by or p.parent in visiting:
                pose = (p.px, p.py, p.pz, p.pyaw) if p else (0, 0, 0, 0)
            else:
                pose = compose(mp(p.parent, visiting | {name}), (p.px, p.py, p.pz, p.pyaw))
            memo[name] = pose
            return pose

        for p in self.props:
            mpose = mp(p.name, set())
            self._map_pose[p.name] = mpose
            wx, wy, wyaw = map_to_world(mpose[0], mpose[1], mpose[3], self.tag)
            item = self.items_by_name[p.name]
            item._is_child = (p.parent != MAP)
            visible = (not p.hidden) and (p.parent == MAP or self.show_children.isChecked())
            item.setVisible(visible)
            # Only root (map) props get an on-canvas label; child sub-frames would just overlap.
            item.label.setVisible(visible and p.parent == MAP)
            item.set_world_pose(wx, wy, wyaw)

    def _subtree_order(self, root: str) -> list[str]:
        """`root` and its descendants, parents before children (BFS)."""
        order: list[str] = []
        seen: set[str] = set()
        queue = [root]
        while queue:
            cur = queue.pop(0)
            if cur in seen:
                continue
            seen.add(cur)
            order.append(cur)
            for c in self.props:
                if c.parent == cur and c.name not in seen:
                    queue.append(c.name)
        return order

    def _reflow_subtree(self, root: str) -> None:
        """Recompute only `root` + descendants; ancestor map poses are reused from cache.

        This is the hot path used while dragging, so it avoids touching the other ~N items.
        """
        if not self.tag:
            return
        by = self._by_name()
        for name in self._subtree_order(root):
            p = by[name]
            if p.parent == MAP or p.parent not in by:
                mpose = (p.px, p.py, p.pz, p.pyaw)
            else:
                parent_map = self._map_pose.get(p.parent, (0.0, 0.0, 0.0, 0.0))
                mpose = compose(parent_map, (p.px, p.py, p.pz, p.pyaw))
            self._map_pose[name] = mpose
            wx, wy, wyaw = map_to_world(mpose[0], mpose[1], mpose[3], self.tag)
            self.items_by_name[name].set_world_pose(wx, wy, wyaw)

    def on_item_dragged(self, item: PropItem, wx: float, wy: float) -> None:
        prop = item.prop
        mx, my, _ = world_to_map(wx, wy, 0.0, self.tag)
        old = self._map_pose.get(prop.name, (mx, my, prop.pz, prop.pyaw))
        self._store_relative(prop, (mx, my, old[2], old[3]))
        self._reflow_subtree(prop.name)
        self._refresh_after_move(prop)

    def on_item_rotated(self, item: PropItem, wyaw: float) -> None:
        prop = item.prop
        _, _, myaw = world_to_map(0.0, 0.0, wyaw, self.tag)
        old = self._map_pose.get(prop.name, (prop.px, prop.py, prop.pz, prop.pyaw))
        self._store_relative(prop, (old[0], old[1], old[2], myaw))
        self._reflow_subtree(prop.name)
        self._refresh_after_move(prop)

    def _store_relative(self, prop: Prop, map_pose: tuple) -> None:
        by = self._by_name()
        if prop.parent == MAP or prop.parent not in by:
            prop.px, prop.py, prop.pz, prop.pyaw = map_pose
        else:
            parent_map = self._map_pose.get(prop.parent, (0, 0, 0, 0))
            prop.px, prop.py, prop.pz, prop.pyaw = decompose(parent_map, map_pose)

    def _refresh_after_move(self, prop: Prop) -> None:
        if self._selected_prop() is prop:
            self._update_reckon_panel()
        self._update_table_rows(self._subtree_order(prop.name))

    def _fill_tree_item(self, item: QTreeWidgetItem, p: Prop) -> None:
        item.setText(0, p.name)
        item.setFlags(item.flags() | Qt.ItemIsUserCheckable)
        item.setCheckState(TABLE_LOCK_COL, Qt.Checked if p.locked else Qt.Unchecked)
        item.setCheckState(TABLE_HIDE_COL, Qt.Checked if p.hidden else Qt.Unchecked)
        for c, val in zip(TREE_POSE_COLS, (f"{p.px:.3f}", f"{p.py:.3f}", f"{p.pz:.3f}", f"{p.pyaw:.1f}")):
            item.setText(c, val)
            item.setTextAlignment(c, Qt.AlignRight | Qt.AlignVCenter)

    def _update_table_rows(self, names) -> None:
        """In-place pose refresh for just the given tree rows (drag hot path)."""
        by = self._by_name()
        for name in names:
            it = self._tree_items.get(name)
            p = by.get(name)
            if it is None or p is None:
                continue
            for c, val in zip(TREE_POSE_COLS, (f"{p.px:.3f}", f"{p.py:.3f}", f"{p.pz:.3f}", f"{p.pyaw:.1f}")):
                it.setText(c, val)

    # ------------------------- selection -------------------------
    # Source of truth is self._selected_name, NOT the graphics item's selected flag:
    # Qt refuses to select an invisible item, so hidden props could not be selected/edited.
    def _selected_item(self) -> PropItem | None:
        return self.items_by_name.get(self._selected_name) if self._selected_name else None

    def _selected_prop(self) -> Prop | None:
        return self._by_name().get(self._selected_name) if self._selected_name else None

    def _select_prop_by_name(self, name: str | None) -> None:
        self._selected_name = name
        self._syncing_selection = True
        self.scene.clearSelection()
        it = self.items_by_name.get(name) if name else None
        if it:
            it.setSelected(True)   # highlights visible props; no-op for hidden ones
        self._syncing_selection = False
        self._update_reckon_panel()
        self._update_edit_panel()
        self._mirror_selection_to_lists()

    def on_selection_changed(self) -> None:
        """Fired when a view click changes the scene selection."""
        if self._syncing_selection:
            return
        name = None
        for n, it in self.items_by_name.items():
            if it.isSelected():
                name = n
                break
        self._selected_name = name
        self._update_reckon_panel()
        self._update_edit_panel()
        self._mirror_selection_to_lists()

    def _on_tree_selection(self) -> None:
        if self._syncing_selection:
            return
        items = self.tree.selectedItems()
        if items:
            self._select_prop_by_name(items[0].text(0))

    def _mirror_selection_to_lists(self) -> None:
        self._syncing_selection = True
        self.tree.clearSelection()
        prop = self._selected_prop()
        if prop:
            it = self._tree_items.get(prop.name)
            if it:
                it.setSelected(True)
                self.tree.setCurrentItem(it)
                parent = it.parent()
                while parent is not None:
                    parent.setExpanded(True)
                    parent = parent.parent()
        self._syncing_selection = False

    # ------------------------- objects tree -------------------------
    def rebuild_tree(self) -> None:
        self._syncing_selection = True
        self.tree.clear()
        self._tree_items = {}
        nodes: dict[str, QTreeWidgetItem] = {}
        for p in [pp for pp in self.props if pp.parent == MAP]:
            it = QTreeWidgetItem()
            self.tree.addTopLevelItem(it)
            nodes[p.name] = it
        remaining = [pp for pp in self.props if pp.parent != MAP]
        made = True
        while remaining and made:
            made = False
            for p in list(remaining):
                if p.parent in nodes:
                    it = QTreeWidgetItem()
                    nodes[p.parent].addChild(it)
                    nodes[p.name] = it
                    remaining.remove(p)
                    made = True
        for p in remaining:  # dangling parent -> show at top
            it = QTreeWidgetItem()
            self.tree.addTopLevelItem(it)
            nodes[p.name] = it
        by = self._by_name()
        for name, it in nodes.items():
            self._tree_items[name] = it
            self._fill_tree_item(it, by[name])
        self.tree.expandAll()
        self._syncing_selection = False
        self._refresh_parent_combo()
        self._mirror_selection_to_lists()

    def _refresh_parent_combo(self) -> None:
        prop = self._selected_prop()
        self.e_parent.blockSignals(True)
        self.e_parent.clear()
        self.e_parent.addItem(MAP)
        if prop:
            banned = {prop.name} | self._descendants(prop.name)
            for p in self.props:
                if p.name not in banned:
                    self.e_parent.addItem(p.name)
            self.e_parent.setCurrentText(prop.parent)
        self.e_parent.blockSignals(False)

    # ------------------------- reckon panel -------------------------
    def _update_reckon_panel(self) -> None:
        prop = self._selected_prop()
        self._loading_panel = True
        enabled = prop is not None
        for w in (self.r_x, self.r_y, self.r_z, self.r_yaw, self.r_lock, self.r_hide):
            w.setEnabled(enabled)
        if prop:
            self.r_name.setText(prop.name)
            self.r_parent.setText("↳ " + prop.parent + ("" if prop.parent == MAP else "_frame"))
            self.r_x.setValue(prop.px)
            self.r_y.setValue(prop.py)
            self.r_z.setValue(prop.pz)
            self.r_yaw.setValue(prop.pyaw)
            self.r_lock.setChecked(prop.locked)
            self.r_hide.setChecked(prop.hidden)
            mp = self._map_pose.get(prop.name, (0, 0, 0, 0))
            wx, wy, _ = map_to_world(mp[0], mp[1], mp[3], self.tag) if self.tag else (0, 0, 0)
            self.r_world.setText(f"map ({mp[0]:.2f},{mp[1]:.2f},{mp[2]:.2f}) yaw {mp[3]:.1f}°   "
                                 f"pool ({wx:.2f},{wy:.2f})")
        else:
            self.r_name.setText("— none —")
            self.r_parent.setText("")
            self.r_world.setText("")
        self._loading_panel = False

    def _apply_rel_to_prop(self) -> None:
        if self._loading_panel:
            return
        prop = self._selected_prop()
        if not prop:
            return
        prop.px, prop.py, prop.pz, prop.pyaw = (self.r_x.value(), self.r_y.value(),
                                                self.r_z.value(), self.r_yaw.value())
        self.reflow()
        self.refresh_table()
        self._update_reckon_panel()

    # ------------------------- edit panel (props tab) -------------------------
    def _update_edit_panel(self) -> None:
        prop = self._selected_prop()
        self._loading_panel = True
        widgets = [self.e_name, self.e_parent, self.e_len, self.e_wid, self.e_color, self.e_img,
                   self.e_imgx, self.e_imgrot, self.e_mesh, self.e_class,
                   self.e_lock, self.e_point, *self.e_cov.values()]
        for w in widgets:
            w.setEnabled(prop is not None)
        if prop:
            self.e_name.setText(prop.name)
            self._refresh_parent_combo()
            self.e_len.setValue(prop.length)
            self.e_wid.setValue(prop.width)
            self.e_imgrot.setValue(prop.image_rot)
            self.e_class.setText(prop.cls or "")
            self.e_lock.setChecked(prop.lock_orientation)
            self.e_point.setChecked(prop.point_yaw_at_parent)
            for k, sp in self.e_cov.items():
                sp.setValue(float(prop.covar.get(k, 1.0)))
            self.e_color.setStyleSheet(f"background:{prop.color};color:white;")
        else:
            self.e_name.setText("")
        self._loading_panel = False

    def _apply_edit(self) -> None:
        if self._loading_panel:
            return
        prop = self._selected_prop()
        if not prop:
            return
        # A manual size change overrides a mesh's asymmetric footprint (back to a centered rect).
        _, _, cur_w, cur_h = prop.local_rect()
        if abs(self.e_len.value() - cur_w) > 1e-3 or abs(self.e_wid.value() - cur_h) > 1e-3:
            prop.img_bbox = None
        prop.length = self.e_len.value()
        prop.width = self.e_wid.value()
        prop.image_rot = self.e_imgrot.value()
        prop.cls = self.e_class.text().strip() or None
        prop.lock_orientation = self.e_lock.isChecked()
        prop.point_yaw_at_parent = self.e_point.isChecked()
        for k, sp in self.e_cov.items():
            prop.covar[k] = sp.value()
        self.items_by_name[prop.name].reload_visuals()
        self.reflow()

    def _rename_selected(self) -> None:
        if self._loading_panel:
            return
        prop = self._selected_prop()
        if not prop:
            return
        new = self.e_name.text().strip()
        if not new or new == prop.name:
            return
        if any(p.name == new for p in self.props):
            QMessageBox.warning(self, "Duplicate name", f"'{new}' already exists.")
            self.e_name.setText(prop.name)
            return
        old = prop.name
        for c in self.props:
            if c.parent == old:
                c.parent = new
        self.items_by_name[new] = self.items_by_name.pop(old)
        prop.name = new
        if self._selected_name == old:
            self._selected_name = new
        self.reflow()
        self.rebuild_tree()
        self._select_prop_by_name(new)
        self.refresh_all()

    def _reparent_selected(self) -> None:
        prop = self._selected_prop()
        if not prop:
            return
        new_parent = self.e_parent.currentText()
        if new_parent == prop.parent:
            return
        # keep the prop where it is in the pool: recompute relative pose under new parent
        cur_map = self._map_pose.get(prop.name, (prop.px, prop.py, prop.pz, prop.pyaw))
        prop.parent = new_parent
        self._store_relative(prop, cur_map)
        self.reflow()
        self.rebuild_tree()
        self._select_prop_by_name(prop.name)
        self.refresh_all()

    def _pick_color(self) -> None:
        prop = self._selected_prop()
        if not prop:
            return
        c = QColorDialog.getColor(QColor(prop.color), self, "Prop color")
        if c.isValid():
            prop.color = c.name()
            self.items_by_name[prop.name].update()
            self._update_edit_panel()

    def _pick_image(self) -> None:
        prop = self._selected_prop()
        if not prop:
            return
        path, _ = QFileDialog.getOpenFileName(self, "Top-down image", str(Path.home()),
                                              "Images (*.png *.jpg *.jpeg *.bmp *.svg)")
        if path:
            prop.image_path = path
            self.items_by_name[prop.name].reload_visuals()

    def _clear_image(self) -> None:
        prop = self._selected_prop()
        if not prop:
            return
        prop.image_path = None
        prop.img_bbox = None
        self.items_by_name[prop.name].reload_visuals()

    # ------------------------- mesh top-down images -------------------------
    def _apply_mesh(self, prop: Prop, png: str, bbox: tuple) -> None:
        prop.image_path = png
        prop.image_rot = 0.0
        prop.img_bbox = tuple(float(v) for v in bbox)
        prop.length = bbox[1] - bbox[0]
        prop.width = bbox[3] - bbox[2]
        it = self.items_by_name.get(prop.name)
        if it:
            it.reload_visuals()

    def _auto_assign_meshes(self) -> None:
        root = Path(MESH_ROOT_DEFAULT)
        if not root.exists():
            QMessageBox.information(self, "Meshes not found", f"Mesh folder not found:\n{root}")
            return
        self.setCursor(Qt.WaitCursor)
        n = 0
        for p in list(self.props):
            d = resolve_mesh_dir(p.name, root)
            if not d:
                continue
            self.statusBar().showMessage(f"Rendering top-down: {d.name}…")
            QApplication.processEvents()
            res = ensure_topdown(d)
            if not res:
                continue
            self._apply_mesh(p, res[0], res[1])
            n += 1
        self.unsetCursor()
        self.reflow()
        self.refresh_all()
        self.statusBar().showMessage(f"Assigned top-down images to {n} of {len(self.props)} props.")

    def _assign_mesh_selected(self) -> None:
        prop = self._selected_prop()
        if not prop:
            return
        d = resolve_mesh_dir(prop.name, Path(MESH_ROOT_DEFAULT))
        if not d:
            QMessageBox.information(self, "No mesh match",
                                    f"No mesh directory matched '{prop.name}'.\n"
                                    "Use 'Top-down image…' to pick one manually.")
            return
        self.setCursor(Qt.WaitCursor)
        QApplication.processEvents()
        res = ensure_topdown(d)
        self.unsetCursor()
        if not res:
            QMessageBox.warning(self, "Render failed", f"Could not render {d.name}/model.dae")
            return
        self._apply_mesh(prop, res[0], res[1])
        self.reflow()
        self._update_edit_panel()
        self.refresh_table()

    def _set_prop_locked(self, prop: Prop, locked: bool) -> None:
        """Lock/unlock a specific prop and keep the view, panels, and table cell in sync."""
        prop.locked = bool(locked)
        it = self.items_by_name.get(prop.name)
        if it:
            it.apply_lock()
            mp = self._map_pose.get(prop.name)
            if mp and self.tag:
                wx, wy, wyaw = map_to_world(mp[0], mp[1], mp[3], self.tag)
                it.set_world_pose(wx, wy, wyaw)   # refresh z-order
        if self._selected_prop() is prop:
            self._loading_panel = True
            self.r_lock.setChecked(prop.locked)
            self.e_locked.setChecked(prop.locked)
            self._loading_panel = False
        self._sync_check_cell(prop.name, TABLE_LOCK_COL, prop.locked)

    def _set_prop_hidden(self, prop: Prop, hidden: bool) -> None:
        """Hide/show a specific prop in the view and keep the panel + tree in sync."""
        prop.hidden = bool(hidden)
        it = self.items_by_name.get(prop.name)
        if it:
            visible = (not prop.hidden) and (prop.parent == MAP or self.show_children.isChecked())
            it.setVisible(visible)
            it.label.setVisible(visible and prop.parent == MAP)
        if self._selected_prop() is prop:
            self._loading_panel = True
            self.r_hide.setChecked(prop.hidden)
            self._loading_panel = False
        self._sync_check_cell(prop.name, TABLE_HIDE_COL, prop.hidden)

    def _sync_check_cell(self, name: str, col: int, checked: bool) -> None:
        it = self._tree_items.get(name)
        if it is None:
            return
        self._syncing_selection = True
        it.setCheckState(col, Qt.Checked if checked else Qt.Unchecked)
        self._syncing_selection = False

    def _toggle_lock(self, locked: bool) -> None:
        if self._loading_panel:
            return
        prop = self._selected_prop()
        if prop:
            self._set_prop_locked(prop, locked)

    def _toggle_hide(self, hidden: bool) -> None:
        if self._loading_panel:
            return
        prop = self._selected_prop()
        if prop:
            self._set_prop_hidden(prop, hidden)

    def _on_tree_item_changed(self, item, column) -> None:
        if self._syncing_selection or column not in (TABLE_LOCK_COL, TABLE_HIDE_COL):
            return
        prop = self._by_name().get(item.text(0))
        if prop is None:
            return
        checked = item.checkState(column) == Qt.Checked
        if column == TABLE_LOCK_COL and checked != prop.locked:
            self._set_prop_locked(prop, checked)
        elif column == TABLE_HIDE_COL and checked != prop.hidden:
            self._set_prop_hidden(prop, checked)

    def _toggle_children(self) -> None:
        self.reflow()

    def _on_set_tag_clicked(self) -> None:
        self.view.enter_tag_mode(self.set_tag_btn.isChecked())

    # ------------------------- refresh / status -------------------------
    def refresh_all(self) -> None:
        self._update_tag_status()
        self.refresh_table()
        self._update_reckon_panel()
        self._update_edit_panel()

    def _update_tag_status(self) -> None:
        if not self.tag:
            self.tag_status.setText("Not set — click the button, then a bottom-line/wall point.")
            return
        walls = {"N": "north", "S": "south", "E": "east", "W": "west"}
        self.tag_status.setText(
            f"{walls.get(self.tag.wall, self.tag.wall)} wall @ pool ({self.tag.x:.3f}, {self.tag.y:.3f}) m\n"
            f"+X into pool at {self.tag.phi:.1f}°  (offset {self.tag.yaw_offset:.1f}°)")

    def refresh_table(self) -> None:
        """Refresh values + check states on the existing tree rows (structure unchanged)."""
        self._syncing_selection = True
        by = self._by_name()
        for name, it in self._tree_items.items():
            p = by.get(name)
            if p is not None:
                self._fill_tree_item(it, p)
        self._syncing_selection = False

    def _on_mouse_moved(self, scene_pt: QPointF) -> None:
        wx, wy = scene_to_world(scene_pt.x(), scene_pt.y())
        if 0 <= wx <= POOL_LENGTH_M and 0 <= wy <= POOL_WIDTH_M:
            msg = f"pool x={wx:.3f} y={wy:.3f}"
            if self.tag:
                mx, my, _ = world_to_map(wx, wy, 0.0, self.tag)
                msg += f"   |   map x={mx:.3f} y={my:.3f}"
            self.statusBar().showMessage(msg)

    # ------------------------- config load / save -------------------------
    def _namespaces(self, doc) -> list[str]:
        out = []
        for k, v in doc.items():
            try:
                if "ros__parameters" in v and "init_data" in v["ros__parameters"]:
                    out.append(k)
            except Exception:
                pass
        return out

    def _load_config(self) -> None:
        start = CONFIG_PATH_DEFAULT if Path(CONFIG_PATH_DEFAULT).exists() else str(Path.home())
        path, _ = QFileDialog.getOpenFileName(self, "Load mapping config", start, "YAML (*.yaml *.yml)")
        if path:
            self._load_config_path(path, auto=False)

    def _load_config_path(self, path: str, auto: bool = False) -> None:
        try:
            if _HAVE_RUAMEL:
                yaml = YAML()
                yaml.preserve_quotes = True
                with open(path) as f:
                    doc = yaml.load(f)
            else:
                import yaml as pyyaml
                with open(path) as f:
                    doc = pyyaml.safe_load(f)
            namespaces = self._namespaces(doc)
            if not namespaces:
                raise ValueError("No '<ns>/riptide_mapping2 -> ros__parameters -> init_data' found.")
            ns = next((n for n in namespaces if "talos" in n), namespaces[0])
            if not auto and len(namespaces) > 1:
                pick, ok = QInputDialog.getItem(self, "Robot namespace", "Load which namespace?",
                                                namespaces, namespaces.index(ns), False)
                if not ok:
                    return
                ns = pick
            self._load_init_data(doc, ns)
            self._doc = doc if _HAVE_RUAMEL else None
            self._ns = ns
            self._config_path = Path(path)
            self._load_viz(path)          # footprints / colors / images / lock / tag / lines, if present
            self.statusBar().showMessage(f"Loaded {len(self.props)} objects from {ns} ({Path(path).name})")
        except Exception as exc:
            if auto:
                self.statusBar().showMessage(f"Auto-load failed: {exc}")
            else:
                QMessageBox.critical(self, "Load failed", str(exc))

    def _load_init_data(self, doc, ns: str) -> None:
        # clear current props
        for it in list(self.items_by_name.values()):
            self.scene.removeItem(it.label)
            self.scene.removeItem(it)
        self.props.clear()
        self.items_by_name.clear()
        self._map_pose.clear()

        init = doc[ns]["ros__parameters"]["init_data"]
        for name, entry in init.items():
            raw_parent = str(entry.get("parent", MAP))
            parent = MAP if raw_parent == MAP else (raw_parent[:-6] if raw_parent.endswith("_frame") else raw_parent)
            pose = entry.get("pose", {}) or {}
            covar = entry.get("covar", {}) or {}
            prop = Prop(
                name=str(name), parent=parent,
                px=float(pose.get("x", 0.0)), py=float(pose.get("y", 0.0)),
                pz=float(pose.get("z", 0.0)), pyaw=float(pose.get("yaw", 0.0)),
                covar={k: float(covar.get(k, 1.0)) for k in ("x", "y", "z", "yaw")},
                lock_orientation=bool(entry.get("lock_orientation_to_config", False)),
                point_yaw_at_parent=bool(entry.get("point_yaw_at_parent", False)),
                cls=(str(entry["class"]) if entry.get("class") is not None else None),
                # Default: everything that isn't a direct child of map is locked (immovable +
                # click-through), so reckoners only grab the root task assemblies. The viz
                # sidecar, loaded afterwards, overrides this with any saved per-prop choices.
                locked=(parent != MAP),
            )
            self._add_prop(prop, is_child=(parent != MAP))
        self.reflow()
        self.rebuild_tree()
        self.refresh_all()
        self.view.fit_all()

    def _save_config(self) -> None:
        if not _HAVE_RUAMEL:
            QMessageBox.warning(self, "ruamel.yaml missing",
                                "Install ruamel.yaml to write the mapping config:\n  pip install ruamel.yaml")
            return
        default = str(self._config_path) if self._config_path else str(Path.home() / "config.yaml")
        path, _ = QFileDialog.getSaveFileName(self, "Save mapping config", default, "YAML (*.yaml *.yml)")
        if not path:
            return
        ns = self._ns
        if ns is None:
            pick, ok = QInputDialog.getText(self, "Robot namespace",
                                            "ROS namespace (e.g. talos, liltank):", text="talos")
            if not ok or not pick.strip():
                return
            ns = f"/{pick.strip()}/riptide_mapping2"
        try:
            yaml = YAML()
            yaml.preserve_quotes = True
            doc = self._doc
            if doc is None:
                doc = CommentedMap()
            if ns not in doc:
                doc[ns] = CommentedMap()
            if "ros__parameters" not in doc[ns]:
                doc[ns]["ros__parameters"] = CommentedMap()
            rp = doc[ns]["ros__parameters"]
            if "init_data" not in rp:
                rp["init_data"] = CommentedMap()
            init = rp["init_data"]
            names = {p.name for p in self.props}
            for p in self.props:
                entry = init.get(p.name)
                if entry is None:
                    entry = CommentedMap()
                    init[p.name] = entry
                entry["parent"] = MAP if p.parent == MAP else f"{p.parent}_frame"
                if p.cls is not None:
                    entry["class"] = p.cls
                elif "class" in entry:
                    del entry["class"]
                self._set_flag(entry, "lock_orientation_to_config", p.lock_orientation)
                self._set_flag(entry, "point_yaw_at_parent", p.point_yaw_at_parent)
                cov = entry.get("covar")
                if cov is None:
                    cov = CommentedMap()
                    entry["covar"] = cov
                for k in ("x", "y", "z", "yaw"):
                    cov[k] = float(p.covar.get(k, 1.0))
                pose = entry.get("pose")
                if pose is None:
                    pose = CommentedMap()
                    entry["pose"] = pose
                pose["x"], pose["y"], pose["z"], pose["yaw"] = (
                    round(p.px, 6), round(p.py, 6), round(p.pz, 6), round(p.pyaw, 6))
            for old in [n for n in list(init.keys()) if n not in names]:
                del init[old]
            if "buffer_size" not in rp:
                rp["buffer_size"] = 60
            with open(path, "w") as f:
                yaml.dump(doc, f)
            self._config_path = Path(path)
            self._ns = ns
            self._doc = doc
            self._save_viz(path)          # persist footprints / colors / images / tag / lines
            self.statusBar().showMessage(f"Saved {len(self.props)} objects to {Path(path).name}")
        except Exception as exc:
            QMessageBox.critical(self, "Save failed", str(exc))

    @staticmethod
    def _set_flag(entry, key: str, value: bool) -> None:
        if value:
            entry[key] = True
        elif key in entry:
            del entry[key]

    # ------------------------- viz sidecar (tool-only attributes) -------------------------
    # Footprint size, color, top-down image, the AprilTag placement and line layout are not part
    # of the ROS config, so they live in a sidecar JSON next to it: "<config>.dr_viz.json".
    @staticmethod
    def _viz_path(cfg_path) -> Path:
        p = Path(cfg_path)
        return p.with_name(p.name + ".dr_viz.json")

    def _save_viz(self, cfg_path) -> None:
        data = {
            "props": {p.name: {"length": p.length, "width": p.width, "color": p.color,
                               "image_path": p.image_path, "image_rot": p.image_rot,
                               "img_bbox": list(p.img_bbox) if p.img_bbox else None,
                               "locked": p.locked, "hidden": p.hidden}
                      for p in self.props},
            "apriltag": (None if not self.tag else
                         {"x": self.tag.x, "y": self.tag.y, "base_phi": self.tag.base_phi,
                          "wall": self.tag.wall, "yaw_offset": self.tag.yaw_offset}),
            "lines": {"short_show": self.short_show.isChecked(), "short_count": self.short_count.value(),
                      "short_spacing": self.short_spacing.value(), "long_show": self.long_show.isChecked(),
                      "long_count": self.long_count.value(), "long_spacing": self.long_spacing.value(),
                      "show_grid": self.show_grid.isChecked(), "show_children": self.show_children.isChecked()},
        }
        try:
            self._viz_path(cfg_path).write_text(json.dumps(data, indent=2), encoding="utf-8")
        except Exception:
            pass  # sidecar is best-effort; never block a config save on it

    @staticmethod
    def _set_blocked(widget, value) -> None:
        widget.blockSignals(True)
        if isinstance(widget, QCheckBox):
            widget.setChecked(bool(value))
        elif isinstance(widget, QSpinBox):
            widget.setValue(int(value))
        elif isinstance(widget, QDoubleSpinBox):
            widget.setValue(float(value))
        widget.blockSignals(False)

    def _load_viz(self, cfg_path) -> None:
        vp = self._viz_path(cfg_path)
        if not vp.exists():
            return
        try:
            data = json.loads(vp.read_text(encoding="utf-8"))
        except Exception:
            return
        ln = data.get("lines") or {}
        for widget, key in ((self.short_show, "short_show"), (self.short_count, "short_count"),
                            (self.short_spacing, "short_spacing"), (self.long_show, "long_show"),
                            (self.long_count, "long_count"), (self.long_spacing, "long_spacing"),
                            (self.show_grid, "show_grid"), (self.show_children, "show_children")):
            if key in ln:
                self._set_blocked(widget, ln[key])
        self.rebuild_static()

        tg = data.get("apriltag")
        if tg:
            self.tag = Tag(tg["x"], tg["y"], tg["base_phi"], tg["wall"], tg.get("yaw_offset", 0.0))
            self._set_blocked(self.tag_offset, self.tag.yaw_offset)
            self.rebuild_tag_gizmo()

        by = self._by_name()
        for name, v in (data.get("props") or {}).items():
            p = by.get(name)
            if not p:
                continue
            p.length = float(v.get("length", p.length))
            p.width = float(v.get("width", p.width))
            p.color = v.get("color") or p.color
            p.image_path = v.get("image_path")
            p.image_rot = float(v.get("image_rot", 0.0))
            p.img_bbox = tuple(v["img_bbox"]) if v.get("img_bbox") else None
            p.locked = bool(v.get("locked", False))
            p.hidden = bool(v.get("hidden", False))
            item = self.items_by_name[name]
            item.reload_visuals()
            item.apply_lock()

        self.reflow()
        self.refresh_all()
        self.view.fit_all()

    def _export_csv(self) -> None:
        path, _ = QFileDialog.getSaveFileName(self, "Export CSV", str(Path.home() / "props.csv"), "CSV (*.csv)")
        if not path:
            return
        if not path.lower().endswith(".csv"):
            path += ".csv"
        try:
            with open(path, "w", newline="") as f:
                w = csv.writer(f)
                w.writerow(["name", "parent", "x", "y", "z", "yaw",
                            "map_x", "map_y", "map_z", "map_yaw"])
                for p in self.props:
                    mp = self._map_pose.get(p.name, (0, 0, 0, 0))
                    w.writerow([p.name, p.parent, round(p.px, 4), round(p.py, 4), round(p.pz, 4),
                                round(p.pyaw, 2), round(mp[0], 4), round(mp[1], 4), round(mp[2], 4),
                                round(mp[3], 2)])
            self.statusBar().showMessage(f"Exported CSV: {path}")
        except Exception as exc:
            QMessageBox.critical(self, "Export failed", str(exc))


# ----------------------------- self test -----------------------------

def _selftest() -> int:
    tag = Tag(0.0, POOL_WIDTH_M / 2, 0.0, "W")
    # map == tag: west wall REP-103
    mx, my, myaw = world_to_map(5.0, POOL_WIDTH_M / 2 + 2.0, 30.0, tag)
    assert abs(mx - 5) < 1e-9 and abs(my - 2) < 1e-9 and abs(myaw - 30) < 1e-9, (mx, my, myaw)
    bx, by, byaw = map_to_world(mx, my, myaw, tag)
    assert abs(bx - 5) < 1e-9 and abs(by - (POOL_WIDTH_M / 2 + 2)) < 1e-9

    # compose / decompose round-trip
    parent = (3.0, 4.0, -1.0, 40.0)
    child = (1.5, -0.5, -0.2, 25.0)
    m = compose(parent, child)
    back = decompose(parent, m)
    for a, b in zip(child, back):
        assert abs(a - b) < 1e-9, (child, back)

    # 2-level chain places a grandchild consistently
    g = compose(parent, (2.0, 0.0, 0.0, 90.0))            # parent -> child frame
    gc = compose(g, (1.0, 0.0, 0.0, 0.0))                 # child -> grandchild
    # grandchild is 1 m along child's +X, which is parent-yaw 40+90=130 deg
    ang = math.radians(130.0)
    exp = (g[0] + math.cos(ang), g[1] + math.sin(ang))
    assert abs(gc[0] - exp[0]) < 1e-9 and abs(gc[1] - exp[1]) < 1e-9, (gc, exp)

    cands = tag_candidates(True, 17, DEFAULT_NINE_FT_M, True, 8, DEFAULT_NINE_FT_M)
    assert len(cands) == (17 + 8) * 2
    print("selftest OK — REP-103 map transform + parent/child composition round-trip.")
    return 0


APP_QSS = """
* { font-size: 12px; color: #232935; }
QMainWindow, QWidget#central, QScrollArea, QScrollArea > QWidget > QWidget { background: #eceef2; }
QToolBar#topbar { background: #ffffff; border: none; border-bottom: 1px solid #dde1e7; padding: 7px 10px; spacing: 6px; }
QToolBar#topbar QLabel#appTitle { font-size: 13px; font-weight: 800; color: #111827; padding-right: 8px; }
QMenuBar { background: #ffffff; border-bottom: 1px solid #dde1e7; padding: 2px; }
QMenuBar::item { padding: 4px 10px; border-radius: 6px; }
QMenuBar::item:selected { background: #eceef2; }
QMenu { background: #ffffff; border: 1px solid #dde1e7; border-radius: 8px; padding: 4px; }
QMenu::item { padding: 5px 22px; border-radius: 6px; }
QMenu::item:selected { background: #eaf0ff; }

QFrame#card { background: #ffffff; border: 1px solid #e4e7ec; border-radius: 12px; }
QLabel#cardTitle { font-weight: 800; color: #111827; }
QLabel#sel { font-weight: 800; font-size: 13px; color: #111827; }
QLabel#muted { color: #7a828f; }
QLabel#mono { color: #6b7280; font-family: 'Menlo','Consolas',monospace; font-size: 11px; }

QPushButton { background: #f4f5f7; border: 1px solid #d7dbe2; border-radius: 8px; padding: 6px 11px; color: #232935; }
QPushButton:hover { background: #eaecf0; }
QPushButton:pressed { background: #e1e4ea; }
QPushButton:disabled { color: #a6acb6; background: #f4f5f7; }
QPushButton#accent { background: #2f6df6; color: #ffffff; border: none; font-weight: 700; }
QPushButton#accent:hover { background: #2a62dd; }
QPushButton#accent:checked, QPushButton#accent:pressed { background: #1f4fbd; }
QPushButton#ghost { background: transparent; border: 1px solid transparent; }
QPushButton#ghost:hover { background: #eceef2; }
QPushButton#chevron { background: transparent; border: none; text-align: left; font-weight: 800; color: #111827; padding: 4px 2px; }
QPushButton#chevron:hover { color: #2f6df6; }

QLineEdit, QDoubleSpinBox, QSpinBox, QComboBox { background: #ffffff; border: 1px solid #cfd4dc; border-radius: 7px; padding: 4px 7px; min-height: 20px; selection-background-color: #2f6df6; }
QLineEdit:focus, QDoubleSpinBox:focus, QSpinBox:focus, QComboBox:focus { border: 1px solid #2f6df6; }
QLineEdit:disabled, QDoubleSpinBox:disabled, QSpinBox:disabled, QComboBox:disabled { background: #f4f5f7; color: #a6acb6; }
QComboBox::drop-down { border: none; width: 20px; }
QDoubleSpinBox::up-button, QSpinBox::up-button, QDoubleSpinBox::down-button, QSpinBox::down-button { width: 16px; border: none; background: transparent; }

QCheckBox { spacing: 7px; }
QCheckBox::indicator { width: 16px; height: 16px; border: 1px solid #c3c9d2; border-radius: 5px; background: #ffffff; }
QCheckBox::indicator:checked { background: #2f6df6; border: 1px solid #2f6df6; image: none; }
QCheckBox::indicator:hover { border: 1px solid #2f6df6; }

QTreeWidget { background: #ffffff; border: 1px solid #e4e7ec; border-radius: 10px; outline: 0; alternate-background-color: #f8f9fb; }
QTreeWidget::item { padding: 4px 2px; border: none; }
QTreeWidget::item:selected { background: #e7efff; color: #111827; }
QHeaderView::section { background: #f4f5f7; color: #6b7280; border: none; border-bottom: 1px solid #e4e7ec; padding: 6px 4px; font-weight: 700; }

QScrollBar:vertical { background: transparent; width: 11px; margin: 3px; }
QScrollBar::handle:vertical { background: #c9ced7; border-radius: 5px; min-height: 28px; }
QScrollBar::handle:vertical:hover { background: #aeb5c0; }
QScrollBar:horizontal { background: transparent; height: 11px; margin: 3px; }
QScrollBar::handle:horizontal { background: #c9ced7; border-radius: 5px; min-width: 28px; }
QScrollBar::handle:horizontal:hover { background: #aeb5c0; }
QScrollBar::add-line, QScrollBar::sub-line { width: 0; height: 0; }
QScrollBar::add-page, QScrollBar::sub-page { background: transparent; }

QSplitter::handle { background: transparent; }
QSplitter::handle:horizontal { width: 8px; }
QSplitter::handle:vertical { height: 8px; }
QStatusBar { background: #ffffff; border-top: 1px solid #dde1e7; color: #6b7280; }
QStatusBar::item { border: none; }
QToolTip { background: #232935; color: #ffffff; border: none; padding: 5px 8px; border-radius: 6px; }
"""


def main() -> int:
    if "--selftest" in sys.argv:
        return _selftest()
    app = QApplication(sys.argv)
    app.setStyle("Fusion")
    font = QFont()
    font.setPointSize(10)
    app.setFont(font)
    app.setStyleSheet(APP_QSS)
    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
