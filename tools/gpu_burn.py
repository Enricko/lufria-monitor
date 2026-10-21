"""Keep an OpenCL GPU busy for N seconds: FMA-heavy kernel + filling half the VRAM.

    python gpu_burn.py 60
"""
import sys
import time

import numpy as np
import pyopencl as cl

seconds = float(sys.argv[1]) if len(sys.argv) > 1 else 60
device = next(d for p in cl.get_platforms() for d in p.get_devices() if d.type & cl.device_type.GPU)
ctx = cl.Context([device])
queue = cl.CommandQueue(ctx)
program = cl.Program(ctx, """
__kernel void burn(__global float *out, int iters) {
  int i = get_global_id(0);
  float a = (float)i * 1e-6f, b = 1.0001f, c = 0.9999f;
  for (int k = 0; k < iters; k++) { a = mad(a, b, c); b = mad(b, c, a); c = mad(c, a, b); }
  out[i] = a + b + c;
}""").build()
burn = cl.Kernel(program, "burn")

n = 1 << 20
out = cl.Buffer(ctx, cl.mem_flags.WRITE_ONLY, n * 4)
vram_bytes = min(device.global_mem_size // 2, device.max_mem_alloc_size) // 4 * 4
vram = cl.Buffer(ctx, cl.mem_flags.READ_WRITE, vram_bytes)
burn.set_args(out, np.int32(4096))

print(f"{device.name}: {vram_bytes >> 20} MiB VRAM, {seconds:.0f}s")
end = time.time() + seconds
launches = 0
while time.time() < end:
    cl.enqueue_nd_range_kernel(queue, burn, (n,), None)
    cl.enqueue_fill_buffer(queue, vram, np.float32(1.5), 0, vram_bytes)
    queue.finish()
    launches += 1
print(f"{launches} launches")
