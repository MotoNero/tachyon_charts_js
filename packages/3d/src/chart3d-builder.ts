// Describes a 3D chart and puts it into a 2D chart builder: a hidden plot, the series with the picture of the scene,
// the labels of the box and the modifier that turns the camera, as Chart3DBuilder of the .NET version.
import { findBuiltInTheme, type Axis, type ChartBuilder, type ThemeDocument } from '@tachyon-charts/core';
import { AxisLabels3D } from './rendering/axis-labels';
import { Orbit3DModifier } from './rendering/orbit-modifier';
import { Scene3DSeries } from './rendering/scene-series';
import type { CameraProjection } from './scene/camera';
import { createBoxAxis, Scene3D } from './scene/scene';
import type { Bars3D } from './scene/bars';
import type { Bubbles3D } from './scene/bubbles';
import type { Mesh3D } from './scene/mesh';
import type { Line3D, Scatter3D } from './scene/points';
import type { Surface3D } from './scene/surface';
import type { Waterfall3D } from './scene/waterfall';

/** Describes a 3D chart: its title, theme, camera and axes, then the elements of the scene. */
export class Chart3DBuilder {
  /** The scene the chart shows. */
  readonly scene = new Scene3D();
  private titleText: string | undefined;
  private themeDocument: ThemeDocument | undefined = findBuiltInTheme('instrument');

  /** The title above the chart. */
  title(title: string): this {
    this.titleText = title;
    return this;
  }

  /** The theme; Instrument by default. */
  theme(theme: ThemeDocument): this {
    this.themeDocument = theme;
    return this;
  }

  /** How the camera projects. */
  projection(projection: CameraProjection): this {
    this.scene.camera.projection = projection;
    return this;
  }

  /** The axis from left to right, by its range and title, or as an axis of its own. */
  xAxis(minimum: number | Axis, maximum?: number, title?: string): this {
    this.scene.xAxis = typeof minimum === 'number' ? createBoxAxis('x3d', minimum, maximum ?? 1, title) : minimum;
    return this;
  }

  /** The axis from front to back, by its range and title, or as an axis of its own. */
  yAxis(minimum: number | Axis, maximum?: number, title?: string): this {
    this.scene.yAxis = typeof minimum === 'number' ? createBoxAxis('y3d', minimum, maximum ?? 1, title) : minimum;
    return this;
  }

  /** The upward axis, by its range and title, or as an axis of its own. */
  zAxis(minimum: number | Axis, maximum?: number, title?: string): this {
    this.scene.zAxis = typeof minimum === 'number' ? createBoxAxis('z3d', minimum, maximum ?? 1, title) : minimum;
    return this;
  }

  /** Adds a waterfall of the rows of a spectrogram. */
  addWaterfall(waterfall: Waterfall3D): this {
    this.scene.addWaterfall(waterfall);
    return this;
  }

  /** Adds a height field. */
  addSurface(surface: Surface3D): this {
    this.scene.addSurface(surface);
    return this;
  }

  /** Adds a surface from triangles. */
  addMesh(mesh: Mesh3D): this {
    this.scene.addMesh(mesh);
    return this;
  }

  /** Adds bubbles. */
  addBubbles(bubbles: Bubbles3D): this {
    this.scene.addBubbles(bubbles);
    return this;
  }

  /** Adds columns over the cells of a grid. */
  addBars(bars: Bars3D): this {
    this.scene.addBars(bars);
    return this;
  }

  /** Adds a line through points in space. */
  addLine(line: Line3D): this {
    this.scene.addLine(line);
    return this;
  }

  /** Adds points in space. */
  addScatter(scatter: Scatter3D): this {
    this.scene.addScatter(scatter);
    return this;
  }

  /** Puts the chart into a builder of a 2D chart. */
  apply(builder: ChartBuilder): ChartBuilder {
    const scene = this.scene;
    let series: Scene3DSeries | undefined;
    if (this.titleText !== undefined) {
      builder.title(this.titleText);
    }
    if (this.themeDocument) {
      builder.theme(this.themeDocument);
    }
    return (
      builder
        .xAxis((a) => a.numeric('x').range(0, 1).hidden())
        .yAxis((a) => a.numeric('y').range(0, 1).hidden())
        .addSeries((x, y) => {
          series = new Scene3DSeries(scene, x, y);
          return series;
        })
        .addOverlay((chart) => {
          series?.bind(chart);
          return new AxisLabels3D(scene);
        })
        .addModifier(() => new Orbit3DModifier(scene))
        // The scene draws with the GPU directly; in a render worker it would hand its picture over through the main memory.
        .drawsOnMainThread()
    );
  }
}

/** Describes a 3D chart in a builder of a 2D chart. */
export function scene3D(builder: ChartBuilder, configure: (chart: Chart3DBuilder) => unknown): ChartBuilder {
  const chart = new Chart3DBuilder();
  configure(chart);
  return chart.apply(builder);
}
