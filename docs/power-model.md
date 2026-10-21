# Power model

There is no wall meter in the loop, so the total is **part measured and part modelled**. The Power page
labels each component as *measured*, *WattSeal model* or *your setting*.

## Components

| Component | Source | Kind |
|---|---|---|
| CPU | Intel RAPL `package` energy counter (via WattSeal, or the helper if WattSeal is down). Includes the integrated GPU | measured |
| Memory | WattSeal's model: flat **5 W** | modelled |
| Storage | WattSeal's model per **physical** disk: HDD 3 W idle + 0.035 W per MiB/s, SSD/NVMe 0.05 W + 0.015, unknown/USB 0.3 W + 0.02 | modelled |
| Network | WattSeal's model per **physical** NIC: 0.2 W + 0.01 W per MiB/s, capped at 3 W | modelled |
| GPU (discrete) | NVIDIA driver `power.draw`, read only while the GPU is awake. 0 W in D3cold. If the driver reports no power, WattSeal's GPU model is used: `0.1·TDP + 0.9·TDP·load^1.6` | measured |
| Platform | `overhead_watts` setting: motherboard, fans, Wi-Fi, adapter loss | your setting |

`total = cpu + memory + storage + network + gpu + platform`

### Why WattSeal's own disk and network numbers aren't used

WattSeal (v1.0.6) enumerates disks and interfaces through `sysinfo`. On a server that means:
- **Storage:** every mount point counts as a disk. LVM volumes, `/boot`, `/boot/efi` and Docker
  `overlay` mounts each get 3 W of "HDD idle".
- **Network:** every interface counts. `lo`, `docker0`, bridges and veth pairs each get 0.2 W.

On the reference server WattSeal reported **25 W** where the physical devices model to about **12 W**.
So the same formulas are applied to `lsblk` whole disks and to interfaces that have a
`/sys/class/net/<if>/device` link, and WattSeal's raw total is kept only to scale per-app numbers.

## Energy and cost

- Every second the sampler integrates `total × Δt` (gaps capped at 5 s, so a suspend isn't counted).
- One row per minute goes into SQLite with energy (Wh), average and peak watts, and a per-component split.
- Hour, day, week and month buckets are grouped in the configured timezone (default `Asia/Jakarta`), not the server's UTC.
- `cost = kWh × tariff × (1 + PPJ%)`.
- **Projection:** the last 24 h average watts × 24 h, × 30 days, or × 365 days.

### PLN tariff presets (Rp/kWh)

| Group | Rate |
|---|---|
| R-1/450 VA (subsidised) | 415 |
| R-1/900 VA (subsidised) | 605 |
| R-1/900 VA RTM | 1,352 |
| R-1/1,300 VA and R-1/2,200 VA | 1,444.70 |
| R-2/3,500–5,500 VA and R-3/6,600 VA+ | 1,699.53 |

PLN sets these every quarter. If they change, pick **Custom** in Settings and type in the new rate.

## Per-app energy

WattSeal splits each second's measured energy between processes by their share of CPU time (and GPU
time, when it can see the GPU). It groups processes by app name and stores the top ones. Consequences:

- On a mostly idle server, the few apps that do run also carry the idle draw. A process at 0.5% CPU can
  show watts, because it is getting a share of the whole package's idle power.
- WattSeal's per-app numbers are relative to *its* inflated total. They are multiplied by
  `Σ(corrected cpu+ram+disk+net) / Σ(WattSeal raw total)` over the same minutes, so the app list adds up to
  the corrected figure, excluding the platform overhead and the dGPU.

The helper aggregates per-app energy for the last 1 h, 24 h, 7 d and 30 d every 2 minutes. WattSeal
itself keeps per-second rows for 24 h and folds older data into hourly rows.

## Calibrating

Plug the server into a cheap power meter and compare the reading at idle and under
`tools/stress-test.sh`. Adjust **Platform overhead** until the idle numbers match. Under load the RAPL CPU
share dominates, and that part is measured.

Reference server (i7-9750H, GTX 1660 Ti, 1 HDD, 1 NVMe):

| State | Model total |
|---|---|
| Idle, dGPU asleep | ≈ 20 W |
| CPU + GPU full load | ≈ 145 W (peak ≈ 178 W): CPU ≈ 45 W at its power limit, GPU ≈ 79 W |
