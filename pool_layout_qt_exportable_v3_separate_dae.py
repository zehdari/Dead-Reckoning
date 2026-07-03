"""
Pool bottom-line layout visualizer + separate DAE exporters for a 50 m x 25 yd pool.

Install:
    python -m pip install PySide6

Run:
    python pool_layout_qt_exportable_v3_separate_dae.py

Export:
    Use the big "EXPORT FLOOR DAE + WALLS DAE" button, File > Export separate DAEs..., or Ctrl+E.

Coordinate system in the exported .dae:
    X = pool long dimension, 50.000 m
    Y = pool short dimension, 25 yd = 22.860 m
    Z = vertical, meters
    Origin = center of pool floor
    Floor top = z = 0
    Walls rise to z = pool depth

The DAE is intentionally simple:
    - One floor-only .dae containing a textured floor plane using a generated PNG floor image.
    - One walls-only .dae containing the four wall planes as a separate file.
    - The lane markings are drawn into the PNG texture, not modeled as geometry.
"""

from __future__ import annotations

import html
import math
import os
import sys
from dataclasses import dataclass
from pathlib import Path

from PySide6.QtCore import Qt, Signal, QPointF, QRectF, QSize
from PySide6.QtGui import (
    QAction,
    QColor,
    QBrush,
    QImage,
    QKeySequence,
    QPainter,
    QPen,
    QPixmap,
)
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QDoubleSpinBox,
    QFileDialog,
    QFormLayout,
    QGraphicsRectItem,
    QGraphicsScene,
    QGraphicsView,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QSizePolicy,
    QSplitter,
    QSlider,
    QSpinBox,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)


M_PER_FT = 0.3048
FT_PER_M = 1.0 / M_PER_FT
M_PER_YD = 0.9144

POOL_LENGTH_M = 50.0
POOL_WIDTH_M = 25.0 * M_PER_YD  # 25 yd = 22.86 m
POOL_DEPTH_M = 7.0 * M_PER_FT   # 7 ft = 2.1336 m

DEFAULT_NINE_FT_M = 9.0 * M_PER_FT
DEFAULT_TEN_IN_M = 10.0 / 12.0 * M_PER_FT


# ----------------------------- unit helpers -----------------------------

def m_to_ft(m: float) -> float:
    return m * FT_PER_M


def ft_to_m(ft: float) -> float:
    return ft * M_PER_FT


def fmt_m_ft(m: float) -> str:
    return f"{m:.3f} m / {m_to_ft(m):.2f} ft"


# ----------------------------- data model -----------------------------

@dataclass
class MarkerParams:
    show: bool
    count: int
    spacing_m: float
    thickness_m: float
    line_length_m: float
    t_width_m: float
    t_thickness_m: float
    show_t: bool


def centered_positions(pool_dimension_m: float, count: int, spacing_m: float) -> list[float]:
    if count <= 0:
        return []
    span = (count - 1) * spacing_m
    start = (pool_dimension_m - span) / 2.0
    return [start + i * spacing_m for i in range(count)]


# ----------------------------- widgets -----------------------------

class DoubleSlider(QWidget):
    """A horizontal slider tied to a QDoubleSpinBox."""

    valueChanged = Signal(float)

    def __init__(
        self,
        minimum: float,
        maximum: float,
        value: float,
        step: float,
        suffix: str = " m",
        decimals: int = 3,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._step = step
        self._scale = round(1.0 / step)

        self.slider = QSlider(Qt.Horizontal)
        self.slider.setRange(round(minimum * self._scale), round(maximum * self._scale))
        self.slider.setSingleStep(1)
        self.slider.setPageStep(10)

        self.spin = QDoubleSpinBox()
        self.spin.setRange(minimum, maximum)
        self.spin.setDecimals(decimals)
        self.spin.setSingleStep(step)
        self.spin.setSuffix(suffix)
        self.spin.setKeyboardTracking(True)
        self.spin.setMinimumWidth(120)

        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.addWidget(self.slider, 1)
        layout.addWidget(self.spin)

        self.slider.valueChanged.connect(self._slider_changed)
        self.spin.valueChanged.connect(self._spin_changed)
        self.setValue(value)

    def value(self) -> float:
        return float(self.spin.value())

    def setValue(self, value: float) -> None:
        value = max(self.spin.minimum(), min(self.spin.maximum(), value))
        self.spin.blockSignals(True)
        self.slider.blockSignals(True)
        self.spin.setValue(value)
        self.slider.setValue(round(value * self._scale))
        self.slider.blockSignals(False)
        self.spin.blockSignals(False)
        self.valueChanged.emit(value)

    def _slider_changed(self, raw_value: int) -> None:
        value = raw_value / self._scale
        self.spin.blockSignals(True)
        self.spin.setValue(value)
        self.spin.blockSignals(False)
        self.valueChanged.emit(value)

    def _spin_changed(self, value: float) -> None:
        self.slider.blockSignals(True)
        self.slider.setValue(round(value * self._scale))
        self.slider.blockSignals(False)
        self.valueChanged.emit(value)


class PoolView(QGraphicsView):
    mouseSceneMoved = Signal(QPointF)

    def __init__(self, scene: QGraphicsScene, parent: QWidget | None = None) -> None:
        super().__init__(scene, parent)
        self.setRenderHint(QPainter.Antialiasing, True)
        self.setDragMode(QGraphicsView.ScrollHandDrag)
        self.setMouseTracking(True)
        self.setBackgroundBrush(QBrush(QColor("#f4f4f4")))
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)

    def wheelEvent(self, event):  # type: ignore[override]
        factor = 1.15 if event.angleDelta().y() > 0 else 1.0 / 1.15
        self.scale(factor, factor)

    def mouseMoveEvent(self, event):  # type: ignore[override]
        self.mouseSceneMoved.emit(self.mapToScene(event.position().toPoint()))
        super().mouseMoveEvent(event)

    def fit_all(self) -> None:
        rect = self.scene().itemsBoundingRect().adjusted(-1.0, -1.0, 1.0, 1.0)
        self.fitInView(rect, Qt.KeepAspectRatio)


# ----------------------------- main window -----------------------------

class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("Woollett Pool Bottom Layout Visualizer + Separate DAE Export v3")
        self.resize(1450, 875)

        self.scene = QGraphicsScene(self)
        self.view = PoolView(self.scene)
        self.view.mouseSceneMoved.connect(self._update_mouse_status)

        self.short_controls = self._make_marker_controls(
            title="17-ish lines parallel to short side — spaced along 50 m length",
            default_count=17,
            default_spacing=DEFAULT_NINE_FT_M,
            default_length=max(1.0, POOL_WIDTH_M - 2.0),
            max_length=POOL_WIDTH_M,
        )
        self.long_controls = self._make_marker_controls(
            title="8-ish lines parallel to long side — spaced along 25 yd width",
            default_count=8,
            default_spacing=DEFAULT_NINE_FT_M,
            default_length=max(1.0, POOL_LENGTH_M - 4.0),
            max_length=POOL_LENGTH_M,
        )

        self.show_grid = QCheckBox("Show 5 m grid")
        self.show_grid.setChecked(True)
        self.show_grid.stateChanged.connect(self.redraw)

        self.texture_res = QSpinBox()
        self.texture_res.setRange(512, 8192)
        self.texture_res.setSingleStep(512)
        self.texture_res.setValue(4096)
        self.texture_res.setSuffix(" px long side")

        self.summary = QTextEdit()
        self.summary.setReadOnly(True)
        self.summary.setMinimumHeight(175)
        self.summary.setMaximumHeight(250)
        self.summary.setStyleSheet("font-family: Menlo, Consolas, monospace; font-size: 12px;")

        export_big = QPushButton("EXPORT FLOOR DAE + WALLS DAE")
        export_big.setMinimumHeight(48)
        export_big.setStyleSheet(
            "QPushButton { font-weight: 800; font-size: 16px; padding: 10px; "
            "background-color: #1f6feb; color: white; border-radius: 6px; }"
            "QPushButton:hover { background-color: #2f81f7; }"
        )
        export_big.clicked.connect(self.export_dae_dialog)

        set_9ft_button = QPushButton("Set both spacings to 9 ft")
        set_9ft_button.clicked.connect(self._set_both_spacing_9ft)

        set_long_25m_button = QPushButton("Set long-way spacing to 2.5 m")
        set_long_25m_button.clicked.connect(lambda: self.long_controls["spacing"].setValue(2.5))  # type: ignore[attr-defined]

        export_small = QPushButton("Export separate DAEs")
        export_small.clicked.connect(self.export_dae_dialog)

        fit_button = QPushButton("Fit view")
        fit_button.clicked.connect(self.view.fit_all)

        top_buttons = QHBoxLayout()
        top_buttons.addWidget(self.show_grid)
        top_buttons.addStretch(1)
        top_buttons.addWidget(set_9ft_button)
        top_buttons.addWidget(set_long_25m_button)
        top_buttons.addWidget(export_small)
        top_buttons.addWidget(fit_button)

        export_box = QGroupBox("Export settings")
        export_form = QFormLayout(export_box)
        export_form.addRow("Floor texture size", self.texture_res)
        hint = QLabel(
            "Exports three files: a floor-only .dae, a walls-only *_walls.dae, "
            "and a *_floor.png texture. Lane markings are baked into the floor texture."
        )
        hint.setWordWrap(True)
        export_form.addRow(hint)

        left_panel = QWidget()
        left_layout = QVBoxLayout(left_panel)
        left_layout.addWidget(export_big)
        left_layout.addLayout(top_buttons)
        left_layout.addWidget(self.short_controls["group"])  # type: ignore[arg-type]
        left_layout.addWidget(self.long_controls["group"])   # type: ignore[arg-type]
        left_layout.addWidget(export_box)
        left_layout.addWidget(QLabel("Computed layout"))
        left_layout.addWidget(self.summary)
        left_layout.addStretch(1)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setWidget(left_panel)
        scroll.setMinimumWidth(320)
        scroll.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)

        # The splitter gives you a draggable divider between settings and viewport.
        # Drag it right to make the settings more visible, or left to maximize the pool view.
        self.splitter = QSplitter(Qt.Horizontal)
        self.splitter.addWidget(scroll)
        self.splitter.addWidget(self.view)
        self.splitter.setChildrenCollapsible(False)
        self.splitter.setStretchFactor(0, 0)
        self.splitter.setStretchFactor(1, 1)
        self.splitter.setSizes([720, 760])

        main = QWidget()
        layout = QHBoxLayout(main)
        layout.addWidget(self.splitter)
        self.setCentralWidget(main)

        self._make_menu()

        self.statusBar().showMessage("Ready")
        self.redraw()
        self.view.fit_all()

    def _make_menu(self) -> None:
        file_menu = self.menuBar().addMenu("File")

        export_action = QAction("Export separate DAEs...", self)
        export_action.setShortcut(QKeySequence("Ctrl+E"))
        export_action.triggered.connect(self.export_dae_dialog)
        file_menu.addAction(export_action)

        quit_action = QAction("Quit", self)
        quit_action.setShortcut(QKeySequence.Quit)
        quit_action.triggered.connect(self.close)
        file_menu.addAction(quit_action)

    def _make_marker_controls(
        self,
        title: str,
        default_count: int,
        default_spacing: float,
        default_length: float,
        max_length: float,
    ) -> dict[str, object]:
        group = QGroupBox(title)
        form = QFormLayout(group)
        form.setFieldGrowthPolicy(QFormLayout.AllNonFixedFieldsGrow)

        show = QCheckBox("Draw this set")
        show.setChecked(True)

        count = QSpinBox()
        count.setRange(1, 64)
        count.setValue(default_count)

        spacing = DoubleSlider(0.25, 5.00, default_spacing, 0.001, " m")
        thickness = DoubleSlider(0.025, 0.75, DEFAULT_TEN_IN_M, 0.001, " m")
        line_length = DoubleSlider(0.50, max_length, default_length, 0.01, " m")
        t_width = DoubleSlider(0.10, 3.00, 1.00, 0.01, " m")
        t_thickness = DoubleSlider(0.025, 0.75, DEFAULT_TEN_IN_M, 0.001, " m")

        show_t = QCheckBox("Draw T marks at both ends")
        show_t.setChecked(True)

        form.addRow(show)
        form.addRow("Number of centerlines", count)
        form.addRow("Center spacing", spacing)
        form.addRow("Line thickness", thickness)
        form.addRow("Main line length", line_length)
        form.addRow("T crossbar width", t_width)
        form.addRow("T crossbar thickness", t_thickness)
        form.addRow(show_t)

        for widget in (show, count, spacing, thickness, line_length, t_width, t_thickness, show_t):
            if isinstance(widget, QCheckBox):
                widget.stateChanged.connect(self.redraw)
            elif isinstance(widget, QSpinBox):
                widget.valueChanged.connect(self.redraw)
            elif isinstance(widget, DoubleSlider):
                widget.valueChanged.connect(self.redraw)

        return {
            "group": group,
            "show": show,
            "count": count,
            "spacing": spacing,
            "thickness": thickness,
            "line_length": line_length,
            "t_width": t_width,
            "t_thickness": t_thickness,
            "show_t": show_t,
        }

    def _params_from_controls(self, controls: dict[str, object]) -> MarkerParams:
        return MarkerParams(
            show=bool(controls["show"].isChecked()),  # type: ignore[attr-defined]
            count=int(controls["count"].value()),  # type: ignore[attr-defined]
            spacing_m=float(controls["spacing"].value()),  # type: ignore[attr-defined]
            thickness_m=float(controls["thickness"].value()),  # type: ignore[attr-defined]
            line_length_m=float(controls["line_length"].value()),  # type: ignore[attr-defined]
            t_width_m=float(controls["t_width"].value()),  # type: ignore[attr-defined]
            t_thickness_m=float(controls["t_thickness"].value()),  # type: ignore[attr-defined]
            show_t=bool(controls["show_t"].isChecked()),  # type: ignore[attr-defined]
        )

    def _set_both_spacing_9ft(self) -> None:
        self.short_controls["spacing"].setValue(DEFAULT_NINE_FT_M)  # type: ignore[attr-defined]
        self.long_controls["spacing"].setValue(DEFAULT_NINE_FT_M)  # type: ignore[attr-defined]

    # ----------------------------- drawing -----------------------------

    def redraw(self, *_args) -> None:
        self.scene.clear()
        self.scene.setSceneRect(-2, -2, POOL_LENGTH_M + 4, POOL_WIDTH_M + 4)

        water = QGraphicsRectItem(0, 0, POOL_LENGTH_M, POOL_WIDTH_M)
        water.setBrush(QBrush(QColor("#d8f3ff")))
        water.setPen(QPen(QColor("#111111"), 0.06))
        self.scene.addItem(water)

        if self.show_grid.isChecked():
            self._draw_grid()

        short_params = self._params_from_controls(self.short_controls)
        long_params = self._params_from_controls(self.long_controls)

        if short_params.show:
            self._draw_short_side_parallel(short_params)
        if long_params.show:
            self._draw_long_side_parallel(long_params)

        self._draw_dimension_labels()
        self._update_summary(short_params, long_params)

    def _draw_grid(self) -> None:
        grid_pen = QPen(QColor(160, 160, 160, 100), 0.02, Qt.DashLine)
        label_color = QColor("#666666")

        x = 5.0
        while x < POOL_LENGTH_M:
            self.scene.addLine(x, 0, x, POOL_WIDTH_M, grid_pen)
            text = self.scene.addText(f"{x:g} m")
            text.setDefaultTextColor(label_color)
            text.setScale(0.08)
            text.setPos(x + 0.05, -0.6)
            x += 5.0

        y = 5.0
        while y < POOL_WIDTH_M:
            self.scene.addLine(0, y, POOL_LENGTH_M, y, grid_pen)
            text = self.scene.addText(f"{y:g} m")
            text.setDefaultTextColor(label_color)
            text.setScale(0.08)
            text.setPos(-1.4, y - 0.15)
            y += 5.0

    def _draw_short_side_parallel(self, p: MarkerParams) -> None:
        positions = centered_positions(POOL_LENGTH_M, p.count, p.spacing_m)
        y0 = (POOL_WIDTH_M - p.line_length_m) / 2.0
        y1 = y0 + p.line_length_m
        brush = QBrush(QColor("#222222"))
        warn_brush = QBrush(QColor("#b00020"))
        use_brush = warn_brush if (positions and (positions[0] < 0 or positions[-1] > POOL_LENGTH_M)) else brush

        for x in positions:
            self._add_rect(x - p.thickness_m / 2.0, y0, p.thickness_m, p.line_length_m, use_brush, z=2)
            if p.show_t:
                self._add_rect(x - p.t_width_m / 2.0, y0 - p.t_thickness_m / 2.0, p.t_width_m, p.t_thickness_m, use_brush, z=3)
                self._add_rect(x - p.t_width_m / 2.0, y1 - p.t_thickness_m / 2.0, p.t_width_m, p.t_thickness_m, use_brush, z=3)

    def _draw_long_side_parallel(self, p: MarkerParams) -> None:
        positions = centered_positions(POOL_WIDTH_M, p.count, p.spacing_m)
        x0 = (POOL_LENGTH_M - p.line_length_m) / 2.0
        x1 = x0 + p.line_length_m
        brush = QBrush(QColor("#003b73"))
        warn_brush = QBrush(QColor("#b00020"))
        use_brush = warn_brush if (positions and (positions[0] < 0 or positions[-1] > POOL_WIDTH_M)) else brush

        for y in positions:
            self._add_rect(x0, y - p.thickness_m / 2.0, p.line_length_m, p.thickness_m, use_brush, z=4)
            if p.show_t:
                self._add_rect(x0 - p.t_thickness_m / 2.0, y - p.t_width_m / 2.0, p.t_thickness_m, p.t_width_m, use_brush, z=5)
                self._add_rect(x1 - p.t_thickness_m / 2.0, y - p.t_width_m / 2.0, p.t_thickness_m, p.t_width_m, use_brush, z=5)

    def _add_rect(self, x: float, y: float, w: float, h: float, brush: QBrush, z: int) -> None:
        item = QGraphicsRectItem(x, y, w, h)
        item.setBrush(brush)
        item.setPen(QPen(Qt.NoPen))
        item.setZValue(z)
        self.scene.addItem(item)

    def _draw_dimension_labels(self) -> None:
        label = self.scene.addText("50.000 m")
        label.setDefaultTextColor(QColor("#222222"))
        label.setScale(0.13)
        label.setPos(POOL_LENGTH_M / 2.0 - 2.0, POOL_WIDTH_M + 0.6)

        label2 = self.scene.addText("25 yd = 22.860 m")
        label2.setDefaultTextColor(QColor("#222222"))
        label2.setScale(0.13)
        label2.setRotation(-90)
        label2.setPos(-1.1, POOL_WIDTH_M / 2.0 + 2.5)

    # ----------------------------- export -----------------------------

    def export_dae_dialog(self) -> None:
        default_path = str(Path.home() / "woollett_pool_layout.dae")
        path, _ = QFileDialog.getSaveFileName(
            self,
            "Export floor DAE + walls DAE + floor PNG",
            default_path,
            "COLLADA DAE (*.dae)",
        )
        if not path:
            return
        if not path.lower().endswith(".dae"):
            path += ".dae"

        floor_dae_path = Path(path)
        walls_dae_path = floor_dae_path.with_name(f"{floor_dae_path.stem}_walls.dae")
        png_path = floor_dae_path.with_name(f"{floor_dae_path.stem}_floor.png")

        short_params = self._params_from_controls(self.short_controls)
        long_params = self._params_from_controls(self.long_controls)
        texture_px = int(self.texture_res.value())

        try:
            export_floor_png(png_path, short_params, long_params, texture_px=texture_px)
            export_floor_dae(floor_dae_path, png_path.name)
            export_walls_dae(walls_dae_path)
        except Exception as exc:  # pragma: no cover - GUI error path
            QMessageBox.critical(self, "Export failed", str(exc))
            return

        QMessageBox.information(
            self,
            "Export complete",
            f"Wrote:\n{floor_dae_path}\n{walls_dae_path}\n{png_path}\n\n"
            "Keep the floor .dae and *_floor.png in the same folder. "
            "The walls .dae is standalone and uses the same meter-based origin."
        )
        self.statusBar().showMessage(
            f"Exported {floor_dae_path.name}, {walls_dae_path.name}, and {png_path.name}"
        )

    # ----------------------------- summary/status -----------------------------

    def _update_summary(self, short_p: MarkerParams, long_p: MarkerParams) -> None:
        lines = [
            "Pool: 50.000 m x 25 yd (22.860 m), depth 7 ft (2.134 m)",
            "Export: floor-only DAE + walls-only DAE + floor PNG texture.",
            "",
            self._summary_for("Short-side-parallel set, spaced along 50 m", POOL_LENGTH_M, short_p),
            "",
            self._summary_for("Long-side-parallel set, spaced along 25 yd", POOL_WIDTH_M, long_p),
            "",
            "Notes:",
            "  • Centerline group is centered: first center = (pool dimension - (count - 1) * spacing) / 2.",
            "  • Red lines mean the selected count/spacing does not fit within the pool dimension.",
            "  • 9 ft = 2.743 m. 2.5 m = 8.20 ft.",
        ]
        self.summary.setPlainText("\n".join(lines))

    def _summary_for(self, label: str, pool_dim_m: float, p: MarkerParams) -> str:
        span = max(0.0, (p.count - 1) * p.spacing_m)
        first_center = (pool_dim_m - span) / 2.0
        last_center = first_center + span
        lane_field_if_spacing_is_width = p.count * p.spacing_m
        outside_if_lane_width = (pool_dim_m - lane_field_if_spacing_is_width) / 2.0
        status = "OK" if first_center >= 0 and last_center <= pool_dim_m else "DOES NOT FIT"
        return "\n".join(
            [
                f"{label}: {status}",
                f"  count: {p.count}",
                f"  center spacing: {fmt_m_ft(p.spacing_m)}",
                f"  center-to-center span: {fmt_m_ft(span)}",
                f"  first center from wall: {fmt_m_ft(first_center)}",
                f"  last center from same wall: {fmt_m_ft(last_center)}",
                f"  line thickness: {fmt_m_ft(p.thickness_m)}",
                f"  main line length: {fmt_m_ft(p.line_length_m)}",
                f"  T width x thickness: {fmt_m_ft(p.t_width_m)} x {fmt_m_ft(p.t_thickness_m)}",
                f"  if spacing is lane width, outside water each side: {fmt_m_ft(outside_if_lane_width)}",
            ]
        )

    def _update_mouse_status(self, scene_pos: QPointF) -> None:
        x = scene_pos.x()
        y = scene_pos.y()
        if 0.0 <= x <= POOL_LENGTH_M and 0.0 <= y <= POOL_WIDTH_M:
            self.statusBar().showMessage(
                f"Mouse: x={x:.3f} m ({m_to_ft(x):.2f} ft), "
                f"y={y:.3f} m ({m_to_ft(y):.2f} ft)"
            )
        else:
            self.statusBar().showMessage("Mouse outside pool")


# ----------------------------- texture generation -----------------------------

def export_floor_png(
    png_path: Path,
    short_p: MarkerParams,
    long_p: MarkerParams,
    texture_px: int = 4096,
) -> None:
    """Draw the current bottom-line layout into one floor texture PNG."""
    width_px = int(texture_px)
    height_px = max(1, round(width_px * POOL_WIDTH_M / POOL_LENGTH_M))

    image = QImage(QSize(width_px, height_px), QImage.Format_ARGB32)
    image.fill(QColor("#d8f3ff"))

    painter = QPainter(image)
    painter.setRenderHint(QPainter.Antialiasing, True)

    def px_rect(x_m: float, y_m: float, w_m: float, h_m: float) -> QRectF:
        return QRectF(
            x_m / POOL_LENGTH_M * width_px,
            y_m / POOL_WIDTH_M * height_px,
            w_m / POOL_LENGTH_M * width_px,
            h_m / POOL_WIDTH_M * height_px,
        )

    # Subtle tile/floor background, purely visual.
    painter.setPen(QPen(QColor(255, 255, 255, 75), max(1, width_px // 1000)))
    tile_m = 2.5
    x = tile_m
    while x < POOL_LENGTH_M:
        xp = x / POOL_LENGTH_M * width_px
        painter.drawLine(round(xp), 0, round(xp), height_px)
        x += tile_m
    y = tile_m
    while y < POOL_WIDTH_M:
        yp = y / POOL_WIDTH_M * height_px
        painter.drawLine(0, round(yp), width_px, round(yp))
        y += tile_m

    # Border.
    painter.setPen(QPen(QColor("#111111"), max(2, width_px // 700)))
    painter.setBrush(Qt.NoBrush)
    painter.drawRect(QRectF(0, 0, width_px - 1, height_px - 1))

    # Draw bottom markings.
    painter.setPen(Qt.NoPen)

    if short_p.show:
        painter.setBrush(QBrush(QColor("#111111")))
        positions = centered_positions(POOL_LENGTH_M, short_p.count, short_p.spacing_m)
        y0 = (POOL_WIDTH_M - short_p.line_length_m) / 2.0
        y1 = y0 + short_p.line_length_m
        for x_m in positions:
            painter.drawRect(px_rect(x_m - short_p.thickness_m / 2.0, y0, short_p.thickness_m, short_p.line_length_m))
            if short_p.show_t:
                painter.drawRect(px_rect(x_m - short_p.t_width_m / 2.0, y0 - short_p.t_thickness_m / 2.0, short_p.t_width_m, short_p.t_thickness_m))
                painter.drawRect(px_rect(x_m - short_p.t_width_m / 2.0, y1 - short_p.t_thickness_m / 2.0, short_p.t_width_m, short_p.t_thickness_m))

    if long_p.show:
        painter.setBrush(QBrush(QColor("#003b73")))
        positions = centered_positions(POOL_WIDTH_M, long_p.count, long_p.spacing_m)
        x0 = (POOL_LENGTH_M - long_p.line_length_m) / 2.0
        x1 = x0 + long_p.line_length_m
        for y_m in positions:
            painter.drawRect(px_rect(x0, y_m - long_p.thickness_m / 2.0, long_p.line_length_m, long_p.thickness_m))
            if long_p.show_t:
                painter.drawRect(px_rect(x0 - long_p.t_thickness_m / 2.0, y_m - long_p.t_width_m / 2.0, long_p.t_thickness_m, long_p.t_width_m))
                painter.drawRect(px_rect(x1 - long_p.t_thickness_m / 2.0, y_m - long_p.t_width_m / 2.0, long_p.t_thickness_m, long_p.t_width_m))

    painter.end()

    png_path.parent.mkdir(parents=True, exist_ok=True)
    if not image.save(str(png_path), "PNG"):
        raise RuntimeError(f"Could not save PNG: {png_path}")


# ----------------------------- DAE generation -----------------------------

def export_floor_dae(dae_path: Path, floor_png_filename: str) -> None:
    """Write a floor-only COLLADA file that uses the generated PNG as its texture."""
    L = POOL_LENGTH_M
    W = POOL_WIDTH_M
    hx = L / 2.0
    hy = W / 2.0
    image_ref = html.escape(floor_png_filename)

    dae = f'''<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset>
    <contributor><authoring_tool>pool_layout_qt_exportable_v3_separate_dae.py</authoring_tool></contributor>
    <unit name="meter" meter="1"/>
    <up_axis>Z_UP</up_axis>
  </asset>

  <library_images>
    <image id="floor_texture_image" name="floor_texture_image">
      <init_from>{image_ref}</init_from>
    </image>
  </library_images>

  <library_effects>
    <effect id="floor_effect">
      <profile_COMMON>
        <newparam sid="floor_surface">
          <surface type="2D"><init_from>floor_texture_image</init_from></surface>
        </newparam>
        <newparam sid="floor_sampler">
          <sampler2D><source>floor_surface</source></sampler2D>
        </newparam>
        <technique sid="common">
          <phong>
            <diffuse><texture texture="floor_sampler" texcoord="UVSET0"/></diffuse>
            <specular><color>0.05 0.05 0.05 1</color></specular>
            <shininess><float>5</float></shininess>
          </phong>
        </technique>
      </profile_COMMON>
    </effect>
  </library_effects>

  <library_materials>
    <material id="floor_material" name="floor_material"><instance_effect url="#floor_effect"/></material>
  </library_materials>

  <library_geometries>
    <geometry id="floor_geometry" name="Floor_Textured_Plane">
      <mesh>
        <source id="floor_positions">
          <float_array id="floor_positions_array" count="12">
            {-hx:.6f} {-hy:.6f} 0   {hx:.6f} {-hy:.6f} 0   {hx:.6f} {hy:.6f} 0   {-hx:.6f} {hy:.6f} 0
          </float_array>
          <technique_common>
            <accessor source="#floor_positions_array" count="4" stride="3">
              <param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/>
            </accessor>
          </technique_common>
        </source>
        <source id="floor_normals">
          <float_array id="floor_normals_array" count="3">0 0 1</float_array>
          <technique_common>
            <accessor source="#floor_normals_array" count="1" stride="3">
              <param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/>
            </accessor>
          </technique_common>
        </source>
        <source id="floor_uvs">
          <float_array id="floor_uvs_array" count="8">0 0  1 0  1 1  0 1</float_array>
          <technique_common>
            <accessor source="#floor_uvs_array" count="4" stride="2">
              <param name="S" type="float"/><param name="T" type="float"/>
            </accessor>
          </technique_common>
        </source>
        <vertices id="floor_vertices"><input semantic="POSITION" source="#floor_positions"/></vertices>
        <triangles material="floor_mat_symbol" count="2">
          <input semantic="VERTEX" source="#floor_vertices" offset="0"/>
          <input semantic="NORMAL" source="#floor_normals" offset="1"/>
          <input semantic="TEXCOORD" source="#floor_uvs" offset="2" set="0"/>
          <p>0 0 0  1 0 1  2 0 2   0 0 0  2 0 2  3 0 3</p>
        </triangles>
      </mesh>
    </geometry>
  </library_geometries>

  <library_visual_scenes>
    <visual_scene id="Scene" name="Scene">
      <node id="floor_node" name="Floor_Textured_Plane">
        <instance_geometry url="#floor_geometry">
          <bind_material>
            <technique_common>
              <instance_material symbol="floor_mat_symbol" target="#floor_material">
                <bind_vertex_input semantic="UVSET0" input_semantic="TEXCOORD" input_set="0"/>
              </instance_material>
            </technique_common>
          </bind_material>
        </instance_geometry>
      </node>
    </visual_scene>
  </library_visual_scenes>

  <scene><instance_visual_scene url="#Scene"/></scene>
</COLLADA>
'''

    dae_path.parent.mkdir(parents=True, exist_ok=True)
    dae_path.write_text(dae, encoding="utf-8")


def export_walls_dae(dae_path: Path) -> None:
    """Write a walls-only COLLADA file using the same origin and dimensions as the floor DAE."""
    L = POOL_LENGTH_M
    W = POOL_WIDTH_M
    D = POOL_DEPTH_M
    hx = L / 2.0
    hy = W / 2.0

    dae = f'''<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset>
    <contributor><authoring_tool>pool_layout_qt_exportable_v3_separate_dae.py</authoring_tool></contributor>
    <unit name="meter" meter="1"/>
    <up_axis>Z_UP</up_axis>
  </asset>

  <library_effects>
    <effect id="wall_effect">
      <profile_COMMON>
        <technique sid="common">
          <phong>
            <diffuse><color>0.72 0.90 0.98 1</color></diffuse>
            <specular><color>0.05 0.05 0.05 1</color></specular>
            <shininess><float>3</float></shininess>
          </phong>
        </technique>
      </profile_COMMON>
    </effect>
  </library_effects>

  <library_materials>
    <material id="wall_material" name="wall_material"><instance_effect url="#wall_effect"/></material>
  </library_materials>

  <library_geometries>
    <geometry id="walls_geometry" name="Walls_Only_Mesh">
      <mesh>
        <source id="wall_positions">
          <float_array id="wall_positions_array" count="48">
            {-hx:.6f} {-hy:.6f} 0  {hx:.6f} {-hy:.6f} 0  {hx:.6f} {-hy:.6f} {D:.6f}  {-hx:.6f} {-hy:.6f} {D:.6f}
            {hx:.6f} {-hy:.6f} 0  {hx:.6f} {hy:.6f} 0  {hx:.6f} {hy:.6f} {D:.6f}  {hx:.6f} {-hy:.6f} {D:.6f}
            {hx:.6f} {hy:.6f} 0  {-hx:.6f} {hy:.6f} 0  {-hx:.6f} {hy:.6f} {D:.6f}  {hx:.6f} {hy:.6f} {D:.6f}
            {-hx:.6f} {hy:.6f} 0  {-hx:.6f} {-hy:.6f} 0  {-hx:.6f} {-hy:.6f} {D:.6f}  {-hx:.6f} {hy:.6f} {D:.6f}
          </float_array>
          <technique_common>
            <accessor source="#wall_positions_array" count="16" stride="3">
              <param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/>
            </accessor>
          </technique_common>
        </source>
        <vertices id="wall_vertices"><input semantic="POSITION" source="#wall_positions"/></vertices>
        <triangles material="wall_mat_symbol" count="8">
          <input semantic="VERTEX" source="#wall_vertices" offset="0"/>
          <p>
             0 1 2   0 2 3
             4 5 6   4 6 7
             8 9 10  8 10 11
             12 13 14  12 14 15
          </p>
        </triangles>
      </mesh>
    </geometry>
  </library_geometries>

  <library_visual_scenes>
    <visual_scene id="Scene" name="Scene">
      <node id="walls_node" name="Walls_Only_Mesh">
        <instance_geometry url="#walls_geometry">
          <bind_material>
            <technique_common>
              <instance_material symbol="wall_mat_symbol" target="#wall_material"/>
            </technique_common>
          </bind_material>
        </instance_geometry>
      </node>
    </visual_scene>
  </library_visual_scenes>

  <scene><instance_visual_scene url="#Scene"/></scene>
</COLLADA>
'''

    dae_path.parent.mkdir(parents=True, exist_ok=True)
    dae_path.write_text(dae, encoding="utf-8")


# ----------------------------- app entry -----------------------------

def main() -> int:
    app = QApplication(sys.argv)
    window = MainWindow()
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
