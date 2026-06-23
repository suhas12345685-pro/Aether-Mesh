// Isolated per-tenant runtime via Docker (dockerode). Each tenant gets a
// *persistent* container — it stays alive between calls, mounting a named
// volume at /workspace so the agent accumulates files across heartbeats.
// Real when INFRA_VM_REAL=true and a Docker daemon is reachable; otherwise
// provisioning/exec are fully simulated.
const REAL = process.env.INFRA_VM_REAL === "true";
const IMAGE = process.env.VM_IMAGE || "aether/tenant-runtime:latest";

const MEM_MB = Number(process.env.VM_MEMORY_MB || 512);
const CPUS   = Number(process.env.VM_CPUS || 1);
const PIDS   = Number(process.env.VM_PIDS_LIMIT || 256);
const NET    = process.env.VM_NETWORK || "bridge";

function hardenedHostConfig(volumeName) {
  return {
    AutoRemove: false,
    NetworkMode: NET,
    Memory: MEM_MB * 1024 * 1024,
    MemorySwap: MEM_MB * 1024 * 1024,
    NanoCpus: Math.round(CPUS * 1e9),
    PidsLimit: PIDS,
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges:true"],
    RestartPolicy: { Name: "unless-stopped" },
    Binds: [`${volumeName}:/workspace`],
  };
}

async function docker() {
  if (!REAL) return null;
  try {
    const Docker = (await import("dockerode")).default;
    return new Docker(process.env.DOCKER_HOST ? { host: process.env.DOCKER_HOST } : undefined);
  } catch (err) {
    console.warn("[vms] dockerode unavailable, simulating:", err.message);
    return null;
  }
}

function containerName(tenantId) { return `aether-tenant-${tenantId}`; }
function volumeName(tenantId)    { return `aether-workspace-${tenantId}`; }

// Returns a running container for the tenant — creates or restarts as needed.
async function ensureContainer(d, tenantId) {
  const vname = volumeName(tenantId);
  const cname = containerName(tenantId);

  // Ensure the workspace volume exists (idempotent).
  try { await d.createVolume({ Name: vname }); } catch { /* exists */ }

  try {
    const c = d.getContainer(cname);
    const info = await c.inspect();
    if (!info.State.Running) await c.start();
    return c;
  } catch {
    // Container doesn't exist; create it.
    const c = await d.createContainer({
      Image: IMAGE,
      name: cname,
      Tty: true,
      OpenStdin: true,
      Labels: { "aether.tenant": tenantId, "aether.managed": "true" },
      HostConfig: hardenedHostConfig(vname),
      WorkingDir: "/workspace",
    });
    await c.start();
    return c;
  }
}

function collect(stream) {
  return new Promise((resolve, reject) => {
    let out = "";
    stream.on("data", (c) => (out += c.toString("utf8")));
    stream.on("end",  () => resolve(out));
    stream.on("error", reject);
  });
}

export async function provisionVm(tenantId) {
  const d = await docker();
  if (!d) {
    return { id: `SIMVM-${tenantId}`, image: IMAGE, status: "running", simulated: true };
  }
  const container = await ensureContainer(d, tenantId);
  return { id: container.id, image: IMAGE, status: "running", simulated: false,
           workspaceVolume: volumeName(tenantId) };
}

// Execute a command inside the tenant's persistent container.
// The working directory defaults to /workspace so file writes accumulate.
export async function vmExec(tenant, command, workdir = "/workspace") {
  const d = await docker();
  if (!d) {
    return { exitCode: 0, stdout: `[simulated] ${command}`, simulated: true };
  }
  const container = await ensureContainer(d, tenant.id);
  const exec = await container.exec({
    Cmd: ["/bin/sh", "-c", command],
    WorkingDir: workdir,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  const stdout = await collect(stream);
  const info = await exec.inspect();
  return { exitCode: info.ExitCode, stdout, simulated: false };
}

export async function vmStatus(tenantId) {
  const d = await docker();
  if (!d) return { status: "simulated", running: true, simulated: true };
  try {
    const info = await d.getContainer(containerName(tenantId)).inspect();
    return {
      status: info.State.Status,
      running: info.State.Running,
      id: info.Id,
      workspaceVolume: volumeName(tenantId),
      simulated: false,
    };
  } catch {
    return { status: "not_found", running: false, simulated: false };
  }
}

export async function destroyVm(tenant) {
  const d = await docker();
  if (!d) return { simulated: true };
  try {
    const c = d.getContainer(containerName(tenant.id));
    await c.remove({ force: true });
  } catch { /* already gone */ }
  // Optionally remove the volume too; commented out so data survives a re-provision.
  // try { await d.getVolume(volumeName(tenant.id)).remove(); } catch {}
  return { removed: true };
}
