# File formats

Tachyon Charts reads data larger than memory from files of its own, and keeps what it derives from them (pyramids,
tiles, stages) in files beside the data, so that the second opening is immediate. The .NET and the JavaScript version
use the same formats: a file written by one is read by the other.

All numbers are **little-endian**. Floating point values are IEEE 754. Headers are padded with zeros to their full
size; readers must ignore the padding. Every format starts with a four-letter tag and a format version, both checked on
reading.

| Tag | Ending | Content | Written by |
|---|---|---|---|
| `TCOL` | any, e.g. `.tcol` | Columns of numbers at an even X step | the user's program |
| `TPYR` | `<data>.tpyr` | Pyramid of minima and maxima of one column | the library, beside the data |
| `TPTS` | `<data>.tpts` | Points of a scatter sorted into tiles | the library, beside the data |
| `TRAS` | any, e.g. `.tras` | A raster (heatmap, spectrogram) of floats | the user's program |
| `TRAP` | `<data>.trap` | Coarser stages of a raster | the library, beside the data |
| `TGEO` | `.tgeo.gz` | Map regions, already cut into triangles | shipped with the geo package |

Derived files (`TPYR`, `TPTS`, `TRAP`) carry a **fingerprint** of the data they were built from. A reader that finds a
file whose fingerprint does not match builds it anew. They are written to `<path>.part` first and renamed when
complete, so a half-written file is never taken.

## Fingerprint

FNV-1a with 64 bits over a sequence of bytes: start with `14695981039346656037`, and for every byte `b`:
`hash = (hash XOR b) * 1099511628211` (modulo 2^64). What goes in is listed per format.

## TCOL – column file

```
offset  size  field
0       4     tag "TCOL" (uint32 0x4C4F4354)
4       4     version, int32 = 1
8       4     value type, int32: 1 float64, 2 float32, 3 int16, 4 int32, 5 bit
12      4     number of columns, int32
16      8     number of rows, int64
24      8     X of the first row, float64
32      8     X step from one row to the next, float64
40      8     rows per block, int64; 0 = one block holding all rows
48      16    zero
64            data
```

The data is stored in **blocks** of rows. Each block holds its rows of the first column, then its rows of the second
column, and so on. Every block but the last has the full number of rows; the last has the rows that are left. With one
block (rows per block 0), the file holds all values of column 0, then all of column 1, and so on. The value of row `r`,
column `c` of type `T` is at

```
block = r / blockRows,  inBlock = rowsInThatBlock,  within = r % blockRows
offset = 64 + (block * blockRows * columns + c * inBlock + within) * sizeof(T)
```

The **bit** type has one column only: 64 rows to a uint64 word, the first row in bit 0, `ceil(rows / 64)` words after
the header.

Blocks let a recorder append rows while the file grows; a file written at once uses one block.

## TPYR – pyramid of extremes

The minimum and maximum of blocks of 256 values of one column, and of groups of 4 blocks of the level below on every
further level, until a level has one block. It answers "the extremes of rows a to b" by reading a few hundred numbers,
whatever the size of the column.

```
offset  size  field
0       4     tag "TPYR" (uint32 0x52595054)
4       4     version, int32 = 1
8       4     size of one value in bytes, int32 (same type as the column)
12      4     number of levels, int32
16      8     number of values of the column, int64
24      8     fingerprint, uint64
32      32    zero
64            levels
```

Level 0 has `ceil(count / 256)` blocks; level `n + 1` has `ceil(blocks(n) / 4)`. Each level is stored as all its
minima, then all its maxima, each an array of the column's value type. NaN and infinities do not count; a block
without a finite value has the largest value of the type as its minimum and the smallest as its maximum.

**Fingerprint:** the number of values (int64), X of the first row and X step (float64 each), then the raw bytes of the
first 4096 values and of the last 4096 values (from `max(0, count - 4096)`; for short columns the two ranges overlap
and both go in).

## TPTS – point tiles

The points of a scatter of any size, sorted once into 1024 × 1024 tiles over their extent, the points of each tile in
a random order, and a grid of 4096 × 4096 counts. A wide view draws the grid as a density; a narrow view reads the
points of the visible tiles, taking a share of each dense tile from its start (the order is random, so any prefix is a
fair sample) and every point of a sparse one.

```
offset  size  field
0       4     tag "TPTS" (uint32 0x53545054)
4       4     version, int32 = 1
8       8     number of rows of the source columns, int64
16      8     number of points with finite X and Y, int64
24      8     fingerprint, uint64
32      8     minimum X, float64
40      8     maximum X, float64
48      8     minimum Y, float64
56      8     maximum Y, float64
64      64    zero
128           tile offsets: (1024 × 1024 + 1) int64
              count grid: 4096 × 4096 uint32
              points: count × (float32 x, float32 y)
```

Tile `t = tileY * 1024 + tileX` (tile 0 at minimum X and minimum Y) holds the points from index `offsets[t]` to
`offsets[t + 1]`. A point's tile is `clamp(floor((x - minX) / (maxX - minX) * 1024), 0, 1023)`, the same for Y; a zero
extent counts as 1. A point is stored as its place **inside its tile**, from 0 to 1 in X and Y, as float32.

The grid cell of a point is `cellX = tileX * 4 + min(3, floor(insideX * 4))`, the same for Y; the count of cell
`(cellX, cellY)` is at index `cellY * 4096 + cellX`.

**Fingerprint:** the number of rows (int64), the size of one source value in bytes (int32), then for X and for Y in
turn, 64 samples: at row `count * s / 64` for `s` from 0 to 63, the raw bytes of up to 64 values (as many as one read
from the source returns there).

## TRAS – raster file

```
offset  size  field
0       4     tag "TRAS" (uint32 0x53415254)
4       4     version, int32 = 1
8       4     width (cells per row), int32
12      4     zero
16      8     height (rows), int64
24      8     left edge of the first column, float64
32      8     width of a column, float64
40      8     lower edge of the first row, float64
48      8     height of a row, float64
56      8     zero
64            rows: height × width float32, row 0 first
```

NaN marks a cell without a value.

## TRAP – raster stages

Coarser copies of a raster, each half as fine in each direction that is longer than 1024 cells and not far shorter
than the other, until neither direction is longer than 1024. A view reads the stage with about one cell per pixel; all
stages together hold about a third of the raster.

```
offset  size  field
0       4     tag "TRAP" (uint32 0x50415254)
4       4     version, int32 = 1
8       4     reduction, int32: 0 nearest, 1 mean, 2 maximum
12      4     zero
16      8     fingerprint, uint64
24      8     lowest finite value of the raster, float64
32      8     highest finite value of the raster, float64
40      88    zero
128           stages, finest first, each height × width float32
```

The sizes follow from the raster's size alone: starting from `(width, height)`, as long as `width > 1024` or
`height > 1024`, the width is halved (rounding up) when `width > 1024` and `2 * width > height`, the height when
`height > 1024` and `2 * height > width`; each result is one stage. A raster no larger than 1024 × 1024 has no stage
(the file holds the header only, for the value range).

A cell of a stage comes from up to two by two cells of the stage below (the raster itself for the first stage):
**nearest** takes the upper-left one, **mean** the mean of the finite ones, **maximum** the highest finite one; NaN
when none is finite.

**Fingerprint:** width (int32), height (int64), left edge, column width, lower edge, row height (float64 each), then 64
rows, row `height * s / 64` for `s` from 0 to 63, the raw bytes of their first `min(width, 256)` floats.

## TGEO – map regions

A gzip-compressed stream holding:

```
uint32  tag "TGEO" (0x4F454754)
int32   version = 1
int32   number of regions
per region:
  string  name
  string  code (ISO 3166-1 alpha-3 for countries)
  int32   number of polygons
  per polygon:
    int32    number of rings, then that many int32: the corners of each ring (outer ring first, then holes)
    float32  x, y for every corner of all rings in turn (longitude and latitude in degrees)
    int32    number of triangle indices, then that many int32: corners of the triangles, three per triangle
```

A `string` is its length in UTF-8 bytes as a 7-bit encoded integer (7 bits per byte, low bits first, the high bit set
on every byte but the last), followed by the bytes. Polygons too small to be cut into triangles are left out.

The world maps of the geo package (`countries-110m`, `-50m`, `-10m`) are made with Natural Earth, which is in the public
domain.
