# NAVSIM 数据集部署与前处理指南

> 部署环境：Kubernetes 容器（Ubuntu, 112 CPU, 8GB cgroup 内存限制, CephFS 50TB 存储）
> 部署日期：2026-03-14
> 服务器：`ssh root@112.30.139.26 -p 52290`

---

## 1. 项目概述

[NAVSIM](https://github.com/autonomousvision/navsim) 是 NeurIPS 2024 的自动驾驶仿真基准测试框架，基于 nuPlan 数据集。本文档记录了在中国大陆服务器上从零部署 NAVSIM 数据集并完成 metric cache 前处理的全过程，包括遇到的问题和解决方案。

### 数据集结构

| 数据集 | 大小 | 说明 |
|--------|------|------|
| `warmup_two_stage` | ~1.2GB | 小规模验证集（2 个场景拼接） |
| `navtrain` (current sensors) | ~301GB (32 splits) | 训练集当前帧传感器数据 |
| `navtrain` (history sensors) | ~145GB (32 splits) | 训练集历史帧传感器数据（未下载） |
| `navsim_logs` (trainval metadata) | ~14GB | 场景日志元数据（pickle 文件） |
| `nuplan-maps` | ~1.4GB | nuPlan 地图数据 |
| `navtest` | 需单独下载 | 测试集（136 个特定日志，不在 trainval 中） |

---

## 2. 服务器环境

### 2.1 硬件与系统

```
CPU: 112 cores
RAM: 1TB（但 cgroup 限制为 8GB）
存储:
  /root          → 49GB Longhorn PVC（不够用）
  /root/highspeedstorage/jwt → 50TB CephFS（主存储）
Python: 3.10（系统自带，无 conda）
GPU: 无
```

### 2.2 网络限制（中国大陆）

| 服务 | 状态 | 解决方案 |
|------|------|----------|
| GitHub (git clone) | ❌ 被墙 | 使用 `codeload.github.com` 下载 tarball |
| HuggingFace | ❌ 被墙 | 使用 `hf-mirror.com` 镜像 |
| AWS S3 (nuplan-maps) | ❌ 被墙 | 本地机器下载后 scp 传输 |
| PyPI | ✅ 正常 | `pip install` 直接使用 |

### 2.3 关键约束：cgroup 内存限制

```bash
# 查看内存限制
cat /sys/fs/cgroup/memory.max
# 输出: 8589934592 (8GB)

# 查看当前使用
cat /sys/fs/cgroup/memory.current
```

虽然宿主机有 1TB 内存，但 Kubernetes Pod 的 cgroup 限制为 **8GB**。超出限制的进程会被 OOM Killer 静默杀掉（无日志输出，进程直接消失）。

---

## 3. 环境搭建

### 3.1 克隆 NAVSIM 仓库

GitHub 在中国被墙，`git clone` 会失败（HTTP2 framing error 或 connection timeout）。使用 codeload 下载 tarball：

```bash
mkdir -p ~/navsim_workspace && cd ~/navsim_workspace
wget -q https://codeload.github.com/autonomousvision/navsim/tar.gz/refs/heads/main -O navsim.tar.gz
tar -xzf navsim.tar.gz
mv navsim-main navsim
rm navsim.tar.gz
```

### 3.2 安装 Python 依赖

```bash
cd ~/navsim_workspace/navsim
pip install -e .

# 安装 nuplan-devkit（NAVSIM 依赖）
pip install nuplan-devkit
```

### 3.3 配置环境变量

在 `~/.bashrc` 中添加：

```bash
export NUPLAN_MAP_VERSION="nuplan-maps-v1.0"
export NUPLAN_MAPS_ROOT="$HOME/navsim_workspace/dataset/maps"
export NAVSIM_EXP_ROOT="$HOME/navsim_workspace/exp"
export NAVSIM_DEVKIT_ROOT="$HOME/navsim_workspace/navsim"
export OPENSCENE_DATA_ROOT="$HOME/navsim_workspace/dataset"
```

> **注意**：这些路径通过 symlink 指向 CephFS 实际存储位置。

### 3.4 存储布局

由于 `/root` 只有 49GB（Longhorn PVC），所有数据存放在 CephFS：

```
/root/highspeedstorage/jwt/navsim_workspace/
├── dataset/
│   ├── maps/                          # nuplan-maps (1.4GB)
│   │   └── nuplan-maps-v1.0/
│   ├── navsim_logs/
│   │   ├── trainval/                  # 1310 个 .pkl 日志文件 (14GB)
│   │   └── test -> trainval           # symlink（navtest 用）
│   ├── sensor_blobs/
│   │   ├── trainval/                  # 1192 个子目录 (301GB)
│   │   └── test -> trainval           # symlink
│   └── warmup_two_stage/              # 验证集 (1.2GB)
└── exp/
    └── metric_cache/                  # 前处理输出

/root/navsim_workspace/
├── navsim/                            # 源码（在 /root PVC 上）
├── dataset -> /root/highspeedstorage/jwt/navsim_workspace/dataset
└── exp -> /root/highspeedstorage/jwt/navsim_workspace/exp
```

---

## 4. 数据下载

### 4.1 nuplan-maps（AWS S3 → 本地中转）

AWS S3 在中国被墙，需要从本地机器下载后 scp 传输：

```bash
# 本地机器
wget https://s3.amazonaws.com/data.nuplan.org/nuplan-maps-v1.0.zip
scp -P 52290 nuplan-maps-v1.0.zip root@112.30.139.26:~/navsim_workspace/dataset/maps/

# 远程服务器
cd ~/navsim_workspace/dataset/maps
unzip nuplan-maps-v1.0.zip
```

### 4.2 warmup_two_stage（hf-mirror）

```bash
cd ~/navsim_workspace/dataset
wget https://hf-mirror.com/datasets/opendrivelab/navsim/resolve/main/warmup_two_stage.tar.gz
tar -xzf warmup_two_stage.tar.gz && rm warmup_two_stage.tar.gz
```

### 4.3 navtrain（32 splits，带重试脚本）

HuggingFace 镜像速度不稳定（200KB/s ~ 30MB/s），wget 经常被系统 kill。使用自定义下载脚本 `download_navtrain_v2.sh`：

```bash
#!/bin/bash
# ~/navsim_workspace/download_navtrain_v2.sh
DATASET="/root/highspeedstorage/jwt/navsim_workspace/dataset"
cd $DATASET
mkdir -p sensor_blobs/trainval

for split in $(seq 1 32); do
  # 跳过已完成的 split
  if [ -f "sensor_blobs/trainval/.done_current_${split}" ]; then
    echo "Split $split already done, skipping"
    continue
  fi

  FILE="navtrain_current_${split}.tar.gz"
  URL="https://hf-mirror.com/datasets/opendrivelab/navsim/resolve/main/${FILE}"

  # 3 次重试
  for attempt in 1 2 3; do
    echo "Downloading split $split (attempt $attempt)..."
    wget -q --timeout=300 "$URL" -O "$FILE" && break
    echo "Failed, retrying in 30s..."
    sleep 30
  done

  if [ ! -f "$FILE" ]; then
    echo "FAILED to download split $split after 3 attempts"
    continue
  fi

  # 解压并移动（用 mv 而不是 cp，CephFS 同分区 mv 是瞬时的）
  tar -xzf "$FILE"
  for dir in navtrain_current_${split}/*/; do
    dirname=$(basename "$dir")
    mv "$dir" "sensor_blobs/trainval/$dirname" 2>/dev/null || true
  done
  rm -rf "navtrain_current_${split}" "$FILE"
  touch "sensor_blobs/trainval/.done_current_${split}"
  echo "Split $split done"
done
echo "All splits completed"
```

关键设计：
- **断点续传**：`.done_current_N` 标记文件，重启后跳过已完成的 split
- **mv 而非 cp**：CephFS 同文件系统内 `mv` 是原子重命名操作（瞬时），`cp` 需要实际复制数据（极慢）
- **3 次重试 + 30s 间隔**：应对 hf-mirror 不稳定

同时运行看门狗脚本监控下载：

```bash
#!/bin/bash
# ~/navsim_workspace/watchdog.sh
while true; do
  # 检查 wget 是否在运行
  if ! pgrep -f wget > /dev/null; then
    echo "$(date): wget not running, download may be complete or crashed"
  fi
  # 检查 10 分钟内文件是否有变化
  sleep 600
done
```

### 4.4 navsim_logs（训练集元数据）

```bash
cd ~/navsim_workspace/dataset
wget https://hf-mirror.com/datasets/opendrivelab/navsim/resolve/main/navsim_logs_trainval.tar.gz
tar -xzf navsim_logs_trainval.tar.gz && rm navsim_logs_trainval.tar.gz
```

> **重要**：解压后目录结构是 `navsim_logs/trainval/trainval/*.pkl`（双层嵌套），需要修复为 `navsim_logs/trainval/*.pkl`：
> ```bash
> cd ~/navsim_workspace/dataset/navsim_logs/trainval
> mv trainval trainval_inner
> mv trainval_inner/*.pkl .
> rmdir trainval_inner
> ```

---

## 5. Metric Cache 前处理

### 5.1 原始方案：Ray（失败）

NAVSIM 默认使用 Ray 分布式框架进行并行前处理：

```bash
python3 navsim/planning/script/run_metric_caching.py \
  train_test_split=navtrain \
  metric_cache_path=$NAVSIM_EXP_ROOT/metric_cache
```

#### 失败原因 1：Ray Worker 死锁

Ray 启动后创建 55+ 个 Worker 进程，但所有 Worker 状态为 `ray::IDLE`，永远不接收任务。主进程 `SceneLoader` 加载日志数据后，无法将任务分发到 Worker。

可能原因：
- 容器环境下 `/dev/shm` 只有 2GB（Ray 需要 30%+ 可用内存），Ray 回退到 `/tmp` 作为 object store
- cgroup 内存限制与 Ray 内部内存管理冲突
- 非标准网络环境（Kubernetes overlay network）影响 Ray gRPC 通信

#### 失败原因 2：OOM Kill（8GB cgroup 限制）

即使绕过 Ray 使用 `worker=sequential` 模式：
1. `SceneLoader` 加载 1192 个日志文件需要 **~7GB 内存**
2. 加载完成后开始处理 scene，额外内存分配触发 cgroup OOM
3. 进程被 OOM Killer **静默杀掉**（无错误日志，进程直接消失）

```bash
# 确认 OOM：进程消失时检查 cgroup 内存
cat /sys/fs/cgroup/memory.current   # ≈ 8589570048 (接近 8GB 上限)
cat /sys/fs/cgroup/memory.max       # = 8589934592 (8GB)
```

#### 失败原因 3：navtest 分割不匹配

最初使用 `train_test_split=navtest`，但 navtest 配置中的 `data_split: test` 指向 `navsim_logs/test/` 目录，而我们的数据在 `trainval/`。即使创建 symlink，navtest 要求的 136 个特定日志文件与我们下载的 1192 个 trainval 日志**完全不重叠**（0/136 匹配）。

### 5.2 最终方案：自定义批量多进程处理

针对 8GB 内存限制，编写了 `batch_preprocess_v3.py`：

```python
#!/usr/bin/env python3
"""批量 metric caching：用 ProcessPoolExecutor 替代 Ray。
每批加载 5 个日志（~300MB），4 个 worker 并行处理。"""

import os, sys, yaml, time, gc
from pathlib import Path
from concurrent.futures import ProcessPoolExecutor, as_completed

# 环境变量配置（省略）...

LOGS_PER_BATCH = 5   # 每批加载的日志数（控制内存）
NUM_WORKERS = 4      # 并行 worker 数（4 × ~800MB ≈ 3.2GB）
DATA_PATH = Path('.../navsim_logs/trainval')
CACHE_PATH = Path('.../exp/metric_cache')

def process_log_batch(log_names_batch):
    """在子进程中处理一批日志。每个子进程独立加载数据、创建 processor、处理 scene。"""
    scene_filter = SceneFilter(log_names=log_names_batch, ...)
    scene_loader = SceneLoader(data_path=DATA_PATH, scene_filter=scene_filter, ...)
    processor = MetricCacheProcessor(cache_path=str(CACHE_PATH), ...)

    for scene_dict in scene_loader.scene_frames_dicts.values():
        scene = Scene.from_scene_dict_list(scene_dict, ...)
        scenario = NavSimScenario(scene, ...)
        processor.compute_and_save_metric_cache(scenario)
        gc.collect()

    return num_success, num_fail

def main():
    all_log_names = load_navtrain_log_names()  # 1192 个日志
    batches = chunk(all_log_names, LOGS_PER_BATCH)  # 239 批

    with ProcessPoolExecutor(max_workers=NUM_WORKERS) as executor:
        futures = {executor.submit(process_log_batch, batch): i
                   for i, batch in enumerate(batches)}
        for future in as_completed(futures):
            success, fail = future.result()
            # 汇总统计...
```

#### 为什么替代 Ray？

| 对比项 | Ray | ProcessPoolExecutor |
|--------|-----|---------------------|
| 内存开销 | 高（object store, GCS server, dashboard, 55+ worker 进程） | 低（仅 4 个 worker 子进程） |
| 8GB 限制下 | OOM kill / Worker 死锁 | 稳定运行在 3-4GB |
| 容器兼容性 | 差（需要 /dev/shm, gRPC 通信） | 好（标准 fork/exec） |
| 数据加载 | 一次性加载全部 1192 个日志 (~7GB) | 每批仅加载 5 个日志 (~300MB) |
| 速度 | N/A（无法运行） | ~170 scenes/min（4 workers） |
| 代码复杂度 | Hydra + Ray 配置 | 纯 Python 标准库 |

#### 关键设计：

1. **小批量加载**：每批 5 个日志 → 每个 worker ~800MB 内存，4 个 worker 共 ~3.2GB
2. **进程级并行**：`ProcessPoolExecutor` 用 fork 创建子进程，避免 Ray 的通信开销
3. **子进程隔离**：每个子进程独立创建 `MetricCacheProcessor`，避免共享状态
4. **GC 积极回收**：每处理一个 scene 后调用 `gc.collect()`

### 5.3 运行命令

```bash
cd ~/navsim_workspace/navsim

nohup python3 -u ~/navsim_workspace/batch_preprocess_v3.py \
  > ~/navsim_workspace/preprocess.log 2>&1 &

# 监控进度
grep -E 'Progress|All done' ~/navsim_workspace/preprocess.log
find ~/highspeedstorage/jwt/navsim_workspace/exp/metric_cache/ -name '*.pkl' | wc -l
```

### 5.4 预期时间

- 总场景数：~60,000 scenes（1192 个日志）
- 处理速度：~170 scenes/min（4 workers）
- 预计总时间：**5-6 小时**

---

## 6. 踩坑总结

| 问题 | 现象 | 解决方案 |
|------|------|----------|
| GitHub 被墙 | `git clone` HTTP2 framing error | 用 `codeload.github.com` 下载 tarball |
| HuggingFace 被墙 | 无法访问 `huggingface.co` | 用 `hf-mirror.com` 镜像 |
| AWS S3 被墙 | nuplan-maps 无法下载 | 本地下载 + scp 传输 |
| `/root` 磁盘满 | 49GB PVC 空间不足 | 数据放 CephFS，用 symlink |
| CephFS 上 cp 极慢 | 拷贝 10GB 数据需要数小时 | 用 `mv`（同分区重命名，瞬时） |
| wget 被 kill | 大文件下载中途被系统终止 | 重试脚本 + 断点续传标记 |
| hf-mirror 速度波动 | 200KB/s ~ 30MB/s 不等 | 看门狗检测卡死 + 自动重试 |
| navsim_logs 嵌套目录 | `trainval/trainval/*.pkl` 双层 | 手动提升一层 |
| navtest 数据不匹配 | 136 个日志名全部缺失 | 改用 `navtrain` 分割 |
| Ray Worker 死锁 | 所有 Worker `IDLE` 不接任务 | 改用 ProcessPoolExecutor |
| 8GB cgroup OOM | 进程静默消失，无错误日志 | 小批量加载 + 限制 worker 数 |
| `nohup` 环境变量丢失 | 子进程读不到 env | 用 `env VAR=val` 显式传递 |

---

## 7. Ray 多机集群加速方案

### 7.1 为什么需要 Ray 集群

单机 4 worker 处理 1192 个日志需要 **~5 天**（瓶颈是 CPU 计算，非 IO）。Metric cache 生成需要对每个 scene 做轨迹采样、碰撞检测、路线评估等 PDM Score 相关的仿真计算，CPU 密集度极高。

Ray 集群可以将任务分发到多台机器，线性提速：

| 方案 | Worker 数 | 预计耗时 |
|------|-----------|----------|
| 单机 ProcessPoolExecutor | 4 | ~5 天 |
| 单机 Ray（8GB 限制） | 4-6 | ~4 天（之前死锁） |
| **10 机 Ray 集群** | **~100+** | **~2-3 小时** |

### 7.2 Ray 集群架构

```
┌─────────────────────────┐
│   Head Node (机器 A)      │
│   ray start --head       │
│   + 提交任务脚本          │
│   端口: 6379(GCS)        │
│         8265(Dashboard)  │
└──────────┬──────────────┘
           │ Ray GCS 协议
    ┌──────┼──────┬──────┬──────┐
    ▼      ▼      ▼      ▼      ▼
┌──────┐┌──────┐┌──────┐┌──────┐┌──────┐
│机器 B ││机器 C ││机器 D ││ ...  ││机器 K │
│Worker││Worker││Worker││Worker││Worker│
│× N   ││× N   ││× N   ││× N   ││× N   │
└──────┘└──────┘└──────┘└──────┘└──────┘
           │
     所有机器都挂载同一个 CephFS
     /root/highspeedstorage/jwt/
```

**前提条件**：
- 所有机器都能访问 **同一个 CephFS 存储**（数据路径一致）
- 所有机器能互相通信（同一内网 / VPC）
- 所有机器安装了相同的 Python 环境和 NAVSIM 依赖

### 7.3 Step 1：停掉当前单机脚本

```bash
# SSH 到当前机器
ssh -p 52290 root@112.30.139.26

# 查看当前进程
ps aux | grep batch_preprocess_v3 | grep -v grep

# 停掉主进程（子 worker 会自动退出）
kill $(ps aux | grep 'batch_preprocess_v3' | grep -v grep | awk 'NR==1{print $2}')

# 确认全部停掉
ps aux | grep batch_preprocess | grep -v grep
# 应该无输出

# 已处理的缓存不会丢失，后续可以跳过
ls /root/highspeedstorage/jwt/navsim_workspace/exp/metric_cache/ | wc -l
# 查看已完成多少个 log 目录
```

### 7.4 Step 2：所有机器环境准备

在每台新机器上执行（可以写成脚本批量 SSH 执行）：

**`setup_worker.sh`** — 在每台 worker 机器上运行：

```bash
#!/bin/bash
# setup_worker.sh — 在每台新租的机器上执行
# 用法: ssh root@<worker_ip> -p <port> 'bash -s' < setup_worker.sh

set -e

echo "=== 1. 检查 CephFS 挂载 ==="
if [ ! -d "/root/highspeedstorage/jwt/navsim_workspace/dataset" ]; then
    echo "ERROR: CephFS 未挂载或路径不一致！"
    echo "请确认 /root/highspeedstorage/jwt/ 可访问"
    exit 1
fi
echo "CephFS OK: $(ls /root/highspeedstorage/jwt/navsim_workspace/dataset/ | wc -l) items"

echo "=== 2. 创建工作目录和 symlink ==="
mkdir -p ~/navsim_workspace
ln -sfn /root/highspeedstorage/jwt/navsim_workspace/dataset ~/navsim_workspace/dataset
ln -sfn /root/highspeedstorage/jwt/navsim_workspace/exp ~/navsim_workspace/exp

echo "=== 3. 克隆 NAVSIM 源码 ==="
cd ~/navsim_workspace
if [ ! -d "navsim" ]; then
    # GitHub 被墙，用 codeload
    wget -q https://codeload.github.com/autonomousvision/navsim/tar.gz/refs/heads/main -O navsim.tar.gz
    tar -xzf navsim.tar.gz && mv navsim-main navsim && rm navsim.tar.gz
fi

echo "=== 4. 安装 Python 依赖 ==="
cd ~/navsim_workspace/navsim
pip install -e . 2>&1 | tail -3
pip install ray 2>&1 | tail -1

echo "=== 5. 设置环境变量 ==="
cat >> ~/.bashrc << 'EOF'
export NUPLAN_MAP_VERSION="nuplan-maps-v1.0"
export NUPLAN_MAPS_ROOT="$HOME/navsim_workspace/dataset/maps"
export NAVSIM_EXP_ROOT="$HOME/navsim_workspace/exp"
export NAVSIM_DEVKIT_ROOT="$HOME/navsim_workspace/navsim"
export OPENSCENE_DATA_ROOT="$HOME/navsim_workspace/dataset"
EOF
source ~/.bashrc

echo "=== 6. 验证 ==="
python3 -c "import ray; import navsim; print(f'Ray {ray.__version__}, NAVSIM OK')"
echo "Setup complete!"
```

### 7.5 Step 3：启动 Ray 集群

#### Head 节点（选一台机器作为 head，比如当前的 112.30.139.26）

```bash
# 获取本机内网 IP
HEAD_IP=$(hostname -I | awk '{print $1}')
echo "Head IP: $HEAD_IP"

# 启动 Ray head 节点
# --num-cpus: 限制本节点 CPU 数（避免 8GB 限制下 OOM）
# --object-store-memory: 限制 object store 大小
ray start --head \
    --port=6379 \
    --dashboard-host=0.0.0.0 \
    --num-cpus=8 \
    --object-store-memory=1000000000

# 检查状态
ray status
```

#### Worker 节点（其他 10 台机器）

```bash
# 在每台 worker 机器上执行，HEAD_IP 替换为 head 节点的内网 IP
HEAD_IP="<head节点内网IP>"

ray start --address="${HEAD_IP}:6379" \
    --num-cpus=8 \
    --object-store-memory=1000000000

# 验证已加入集群
ray status  # 应该能看到多个节点
```

**批量启动脚本 `start_ray_workers.sh`**（在 head 节点上执行）：

```bash
#!/bin/bash
# start_ray_workers.sh — 在 head 节点上运行，批量启动所有 worker
# 修改 WORKERS 数组为你的机器 IP 和端口

HEAD_IP=$(hostname -I | awk '{print $1}')

# 格式: "IP:PORT"
WORKERS=(
    "10.0.0.2:22"
    "10.0.0.3:22"
    "10.0.0.4:22"
    "10.0.0.5:22"
    "10.0.0.6:22"
    "10.0.0.7:22"
    "10.0.0.8:22"
    "10.0.0.9:22"
    "10.0.0.10:22"
    "10.0.0.11:22"
)

for worker in "${WORKERS[@]}"; do
    IFS=':' read -r ip port <<< "$worker"
    echo "Starting Ray on $ip:$port ..."
    ssh -p "$port" root@"$ip" \
        "source ~/.bashrc && ray start --address='${HEAD_IP}:6379' --num-cpus=8 --object-store-memory=1000000000" &
done

wait
echo "All workers started. Checking cluster status..."
ray status
```

### 7.6 Step 4：提交 metric caching 任务

有两种方式：

#### 方式 A：使用 NAVSIM 原生 Hydra 命令（推荐）

在 head 节点上运行，Ray 集群已启动后 NAVSIM 会自动检测到并分发任务：

```bash
cd ~/navsim_workspace/navsim

# 设置环境变量
source ~/.bashrc

# 运行 metric caching — NAVSIM 默认用 ray_distributed_no_torch worker
# Ray 会自动连接到已有集群（因为 ray.init(address='auto') 会检测本地 Ray）
python3 navsim/planning/script/run_metric_caching.py \
    train_test_split=navtrain \
    metric_cache_path=$NAVSIM_EXP_ROOT/metric_cache \
    worker.threads_per_node=8
```

> **注意**：NAVSIM 的 `run_metric_caching.py` 中有一行 `if cfg.worker == "ray_distributed" and cfg.worker.use_distributed: raise AssertionError`，但默认用的是 `ray_distributed_no_torch`，不会触发这个断言。

**如果原生命令仍然死锁**（之前在单机上遇到过），使用方式 B。

#### 方式 B：自定义 Ray 脚本（保底方案）

**`ray_cluster_preprocess.py`** — 放在 head 节点上：

```python
#!/usr/bin/env python3
"""Ray 集群版 metric caching。
在已启动的 Ray 集群上分发 NAVSIM metric cache 计算任务。
已处理的 log 会自动跳过。"""

import os, sys, yaml, time, gc
from pathlib import Path

# 环境变量
os.environ['NUPLAN_MAP_VERSION'] = 'nuplan-maps-v1.0'
os.environ['NUPLAN_MAPS_ROOT'] = os.path.expanduser('~/navsim_workspace/dataset/maps')
os.environ['NAVSIM_EXP_ROOT'] = os.path.expanduser('~/navsim_workspace/exp')
os.environ['NAVSIM_DEVKIT_ROOT'] = os.path.expanduser('~/navsim_workspace/navsim')
os.environ['OPENSCENE_DATA_ROOT'] = os.path.expanduser('~/navsim_workspace/dataset')

sys.path.insert(0, os.path.expanduser('~/navsim_workspace/navsim'))

import ray

DATA_PATH = Path(os.path.expanduser(
    '~/navsim_workspace/dataset/navsim_logs/trainval'))
CACHE_PATH = Path(os.path.expanduser(
    '~/navsim_workspace/exp/metric_cache'))
LOGS_PER_TASK = 3  # 每个 Ray task 处理的日志数

@ray.remote(num_cpus=1, max_retries=2)
def process_log_batch(log_names_batch):
    """Ray remote function：在集群任意节点上执行。"""
    import os, gc, sys
    from pathlib import Path

    # 每个 worker 需要重新设置环境（Ray remote 在不同机器上执行）
    os.environ['NUPLAN_MAP_VERSION'] = 'nuplan-maps-v1.0'
    os.environ['NUPLAN_MAPS_ROOT'] = os.path.expanduser(
        '~/navsim_workspace/dataset/maps')
    os.environ['NAVSIM_EXP_ROOT'] = os.path.expanduser(
        '~/navsim_workspace/exp')
    os.environ['OPENSCENE_DATA_ROOT'] = os.path.expanduser(
        '~/navsim_workspace/dataset')
    sys.path.insert(0, os.path.expanduser('~/navsim_workspace/navsim'))

    from navsim.common.dataloader import SceneFilter, SceneLoader
    from navsim.common.dataclasses import Scene, SensorConfig
    from navsim.planning.metric_caching.metric_cache_processor import (
        MetricCacheProcessor,
    )
    from navsim.planning.scenario_builder.navsim_scenario import NavSimScenario
    from nuplan.planning.simulation.trajectory.trajectory_sampling import (
        TrajectorySampling,
    )

    data_path = Path(os.path.expanduser(
        '~/navsim_workspace/dataset/navsim_logs/trainval'))
    cache_path = Path(os.path.expanduser(
        '~/navsim_workspace/exp/metric_cache'))
    synthetic_path = Path(os.path.expanduser(
        '~/navsim_workspace/dataset/navhard_two_stage/synthetic_scene_pickles'))

    processor = MetricCacheProcessor(
        cache_path=str(cache_path),
        force_feature_computation=True,
        proposal_sampling=TrajectorySampling(
            num_poses=40, interval_length=0.1),
    )

    scene_filter = SceneFilter(
        num_history_frames=4, num_future_frames=10, frame_interval=1,
        has_route=True, max_scenes=None,
        log_names=log_names_batch, tokens=None,
    )

    scene_loader = SceneLoader(
        synthetic_sensor_path=None, original_sensor_path=None,
        data_path=data_path,
        synthetic_scenes_path=synthetic_path,
        scene_filter=scene_filter,
        sensor_config=SensorConfig.build_no_sensors(),
    )

    num_success, num_fail = 0, 0
    for scene_dict in scene_loader.scene_frames_dicts.values():
        try:
            scene = Scene.from_scene_dict_list(
                scene_dict, None,
                num_history_frames=4, num_future_frames=10,
                sensor_config=SensorConfig.build_no_sensors(),
            )
            scenario = NavSimScenario(
                scene,
                map_root=os.environ['NUPLAN_MAPS_ROOT'],
                map_version='nuplan-maps-v1.0',
            )
            processor.compute_and_save_metric_cache(scenario)
            num_success += 1
        except Exception as e:
            num_fail += 1
        gc.collect()

    return log_names_batch, num_success, num_fail


def get_completed_logs(cache_path):
    """扫描已完成的 log 目录，用于跳过已处理的日志。"""
    if not cache_path.exists():
        return set()
    return set(d.name for d in cache_path.iterdir() if d.is_dir())


def main():
    # 连接到已有 Ray 集群
    ray.init(address='auto')
    print(f"Ray cluster: {ray.cluster_resources()}")
    total_cpus = int(ray.cluster_resources().get('CPU', 0))
    print(f"Total CPUs in cluster: {total_cpus}")

    # 加载所有日志名
    filter_path = os.path.expanduser(
        '~/navsim_workspace/navsim/navsim/planning/script/config'
        '/common/train_test_split/scene_filter/navtrain.yaml')
    with open(filter_path) as f:
        filter_cfg = yaml.safe_load(f)
    all_log_names = filter_cfg['log_names']

    # 跳过已完成的日志
    completed = get_completed_logs(CACHE_PATH)
    remaining = [name for name in all_log_names if name not in completed]
    print(f"Total: {len(all_log_names)}, "
          f"Completed: {len(completed)}, "
          f"Remaining: {len(remaining)}")

    if not remaining:
        print("All logs already processed!")
        return

    # 分批创建 Ray tasks
    batches = [remaining[i:i+LOGS_PER_TASK]
               for i in range(0, len(remaining), LOGS_PER_TASK)]

    print(f"Submitting {len(batches)} tasks "
          f"({LOGS_PER_TASK} logs/task) to {total_cpus} CPUs...")
    t_start = time.time()

    # 提交所有任务
    futures = [process_log_batch.remote(batch) for batch in batches]

    # 等待结果
    total_success, total_fail = 0, 0
    completed_tasks = 0
    while futures:
        done, futures = ray.wait(futures, num_returns=1, timeout=None)
        for ref in done:
            try:
                log_names, success, fail = ray.get(ref)
                total_success += success
                total_fail += fail
            except Exception as e:
                print(f"  Task failed: {e}")
            completed_tasks += 1
            if completed_tasks % 20 == 0 or not futures:
                elapsed = time.time() - t_start
                rate = total_success / max(elapsed, 1) * 60
                print(f"  [{completed_tasks}/{len(batches)+completed_tasks}] "
                      f"{total_success} ok, {total_fail} fail, "
                      f"{rate:.0f} scenes/min, "
                      f"{elapsed:.0f}s elapsed")

    elapsed = time.time() - t_start
    print(f"\nAll done! {total_success} success, "
          f"{total_fail} fail in {elapsed:.0f}s "
          f"({elapsed/60:.1f} min)")


if __name__ == '__main__':
    main()
```

**关键设计**：

1. **自动跳过已处理的日志**：`get_completed_logs()` 扫描 `metric_cache/` 目录，跳过之前单机脚本已处理的 ~98 个 log
2. **每个 Ray task 设置环境变量**：因为 task 可能在任意机器执行，需要在 `@ray.remote` 函数内部重新设置 `os.environ`
3. **`num_cpus=1`**：每个 task 只占用 1 个 CPU slot，让 Ray 自动调度到空闲节点
4. **`max_retries=2`**：单个 task 失败自动重试（OOM 等临时故障）
5. **`LOGS_PER_TASK=3`**：每个 task 处理 3 个日志，平衡任务粒度与开销

### 7.7 Step 5：监控集群运行状态

```bash
# Ray Dashboard（在 head 节点上）
# 浏览器访问 http://<head_ip>:8265

# 命令行检查集群状态
ray status

# 查看运行中的任务数
ray summary tasks

# 查看已处理的 log 目录数
ls /root/highspeedstorage/jwt/navsim_workspace/exp/metric_cache/ | wc -l

# 查看脚本日志
tail -f ~/navsim_workspace/ray_preprocess.log
```

### 7.8 Step 6：停掉 Ray 集群

处理完成后，关闭所有节点：

```bash
# 在 head 节点
ray stop

# 批量停掉 worker 节点
for worker in "${WORKERS[@]}"; do
    IFS=':' read -r ip port <<< "$worker"
    ssh -p "$port" root@"$ip" "ray stop" &
done
wait
echo "Ray cluster stopped."
```

### 7.9 运行命令速查

```bash
# === 完整流程 ===

# 1. 停掉当前单机脚本
kill $(ps aux | grep 'batch_preprocess_v3' | grep -v grep | head -1 | awk '{print $2}')

# 2. 在所有 worker 机器上执行环境准备（替换 IP 和端口）
for worker in "10.0.0.2:22" "10.0.0.3:22" ...; do
    IFS=':' read -r ip port <<< "$worker"
    ssh -p "$port" root@"$ip" 'bash -s' < setup_worker.sh &
done
wait

# 3. Head 节点启动 Ray
ray start --head --port=6379 --dashboard-host=0.0.0.0 --num-cpus=8 --object-store-memory=1000000000

# 4. Worker 节点加入集群
bash start_ray_workers.sh

# 5. 确认集群规模
ray status   # 应显示 11 个节点

# 6. 提交任务
cd ~/navsim_workspace/navsim
nohup python3 -u ~/navsim_workspace/ray_cluster_preprocess.py \
    > ~/navsim_workspace/ray_preprocess.log 2>&1 &

# 7. 监控
tail -f ~/navsim_workspace/ray_preprocess.log
watch -n 30 'ls /root/highspeedstorage/jwt/navsim_workspace/exp/metric_cache/ | wc -l'
```

### 7.10 性能预估

| 集群规模 | Worker 数 | 预计速度 | 预计耗时（剩余 ~1100 logs） |
|----------|-----------|----------|---------------------------|
| 1 机 × 4 worker | 4 | ~10 logs/h | ~5 天 |
| 11 机 × 8 worker | 88 | ~220 logs/h | **~5 小时** |
| 11 机 × 16 worker | 176 | ~440 logs/h | **~2.5 小时** |

> `--num-cpus` 可以根据每台机器的内存限制调整。如果新机器没有 8GB cgroup 限制（比如独占物理机），可以设更高。

### 7.11 常见问题

| 问题 | 解决方案 |
|------|----------|
| Worker 连不上 Head | 检查防火墙/安全组，开放 6379、8265 端口；确认用内网 IP |
| `ModuleNotFoundError: navsim` | Worker 机器未安装 NAVSIM，运行 `setup_worker.sh` |
| CephFS 路径不一致 | 确认所有机器的挂载点路径相同（`/root/highspeedstorage/jwt/`） |
| Task OOM 被 kill | 减小 `LOGS_PER_TASK`（从 3 降到 1）或增加 `--num-cpus`（减少并行 task 数） |
| Ray Dashboard 打不开 | 确认 `--dashboard-host=0.0.0.0`，检查 8265 端口是否开放 |
| 部分 task 失败 | `max_retries=2` 自动重试；也可重新运行脚本（自动跳过已完成的 log） |

---

## 8. 多机分片并行方案（实际采用）

> Ray 集群方案（第7节）因容器环境 worker 进程隔离问题失败，最终采用分片并行方案。

### 8.1 方案原理

每台机器独立运行 `shard_preprocess.py`，通过 `shard_id / total_shards` 分配不重叠的 log 子集。所有机器通过 CephFS 共享存储读写数据，无需机器间通信。

```
Machine 0: logs[0, 10, 20, 30, ...]
Machine 1: logs[1, 11, 21, 31, ...]
Machine 2: logs[2, 12, 22, 32, ...]
...
Machine 9: logs[9, 19, 29, 39, ...]
```

### 8.2 shard_preprocess.py

```python
#!/usr/bin/env python3
"""分片并行 metric caching — 每台机器运行不同 shard"""
import sys, os, yaml
from pathlib import Path
from concurrent.futures import ProcessPoolExecutor, as_completed

LOGS_PER_BATCH = 5

def process_log_batch(log_names):
    """在子进程中处理一批 log"""
    os.environ['NUPLAN_DATA_ROOT'] = '/root/highspeedstorage/jwt/navsim_workspace/dataset'
    os.environ['NAVSIM_EXP_ROOT'] = '/root/highspeedstorage/jwt/navsim_workspace/exp'
    os.environ['NUPLAN_MAPS_ROOT'] = '/root/highspeedstorage/jwt/navsim_workspace/dataset/maps'
    sys.path.insert(0, '/root/navsim_workspace/navsim')

    from hydra import compose, initialize_config_dir
    from navsim.planning.script.run_metric_caching import main as run_main

    config_path = os.path.abspath('/root/navsim_workspace/navsim/navsim/planning/script/config')
    success, fail = 0, 0
    for log_name in log_names:
        try:
            with initialize_config_dir(config_dir=config_path, version_base=None):
                cfg = compose(
                    config_name='metric_caching',
                    overrides=[
                        'experiment_name=metric_cache',
                        'train_test_split=navtrain',
                        f'+train_test_split.scene_filter.log_names=[{log_name}]',
                        'worker=sequential',
                    ]
                )
                run_main(cfg)
            success += 1
        except Exception as e:
            print(f'FAILED {log_name}: {e}')
            fail += 1
    return log_names, success, fail

def main():
    shard_id = int(sys.argv[1])
    total_shards = int(sys.argv[2])
    num_workers = int(sys.argv[3]) if len(sys.argv) > 3 else 40

    # 加载全部 log 名
    yaml_path = '/root/navsim_workspace/navsim/navsim/planning/script/config/common/train_test_split/scene_filter/navtrain.yaml'
    with open(yaml_path) as f:
        all_log_names = yaml.safe_load(f)['log_names']

    # 跳过已完成的 log
    cache_path = Path('/root/highspeedstorage/jwt/navsim_workspace/exp/metric_cache')
    completed = set(d.name for d in cache_path.iterdir() if d.is_dir())
    remaining = [n for n in all_log_names if n not in completed]

    # 取本分片
    my_logs = [remaining[i] for i in range(shard_id, len(remaining), total_shards)]
    print(f'Shard {shard_id}/{total_shards}: {len(my_logs)} logs to process (skipped {len(completed)} completed)')

    # 分批并行
    batches = [my_logs[i:i+LOGS_PER_BATCH] for i in range(0, len(my_logs), LOGS_PER_BATCH)]
    done, total = 0, len(my_logs)
    with ProcessPoolExecutor(max_workers=num_workers) as executor:
        futures = {executor.submit(process_log_batch, b): i for i, b in enumerate(batches)}
        for future in as_completed(futures):
            names, s, f = future.result()
            done += s + f
            print(f'[{done}/{total}] batch done, success={s}, fail={f}')

if __name__ == '__main__':
    main()
```

### 8.3 使用方法

```bash
# 在每台机器上运行（shard_id 从 0 开始，每台不同）
nohup python3 -u shard_preprocess.py <shard_id> <total_shards> <num_workers> > shard.log 2>&1 &

# 示例：10 台机器，每台 4 workers（8GB 内存限制）
# 机器1: python3 -u shard_preprocess.py 0 10 4
# 机器2: python3 -u shard_preprocess.py 1 10 4
# ...
# 机器10: python3 -u shard_preprocess.py 9 10 4
```

### 8.4 监控进度

```bash
# 从任意可访问 CephFS 的机器查看总完成数
ls /root/highspeedstorage/jwt/navsim_workspace/exp/metric_cache/ | wc -l
# 期望输出: 1192（全部完成）

# 查看本机进程
ps aux | grep shard_preprocess

# 查看本机日志
tail -f shard.log
```

### 8.5 实际执行记录

| 项目 | 详情 |
|------|------|
| 开始时间 | 2026-03-15 ~14:40 |
| 完成时间 | 2026-03-15 ~19:00 |
| 总耗时 | ~4.5 小时 |
| 机器数量 | 10 台小机器 + 4 台大机器（SSH 不可达但可能有贡献） |
| 每台 Worker 数 | 4（受 8GB cgroup 限制） |
| CPU 利用率 | ~20-30%（112核只用4个worker） |
| IO 瓶颈 | 无，IO 接近 0（纯 CPU 计算） |
| 最终结果 | **1192/1192 logs 全部完成** |

### 8.6 Ray 失败原因总结

| 问题 | 详情 |
|------|------|
| Worker 进程隔离 | Ray worker 在容器中运行时，子进程找不到 `tqdm`、`numpy`、`nuplan` 等 pip 包 |
| 任务不分发 | 所有 task 只在 head 节点执行，worker 节点空闲 |
| 环境不可控 | 容器内 Ray 的 Python 环境与宿主 pip 环境隔离，无法通过 `runtime_env` 解决 |
| **结论** | 在 K8s 容器中不推荐用 Ray，改用分片 + ProcessPoolExecutor 更可靠 |

---

## 9. 数据交接文档

### 9.1 数据总览

| 数据 | 路径 | 大小 | 状态 |
|------|------|------|------|
| NAVSIM 源码 | `/root/navsim_workspace/navsim/` | ~50MB | ✅ 已部署 |
| nuPlan 地图 | `CephFS/dataset/maps/nuplan-maps-v1.0/` | ~1.4GB | ✅ 已下载 |
| trainval 日志元数据 | `CephFS/dataset/navsim_logs/trainval/` | ~14GB | ✅ 已下载（1310 个 .pkl） |
| trainval 当前传感器 | `CephFS/dataset/sensor_blobs/trainval/` | ~301GB | ✅ 已下载（1192 个子目录，32 splits） |
| **metric cache** | **`CephFS/exp/metric_cache/`** | **~数GB** | **✅ 全部完成（1192/1192 logs）** |
| trainval 历史传感器 | — | ~145GB | ❌ 未下载 |
| navtest 测试集 | — | 待确认 | ❌ 未下载 |

> `CephFS` = `/root/highspeedstorage/jwt/navsim_workspace`

### 9.2 完整目录结构

```
/root/highspeedstorage/jwt/navsim_workspace/     ← CephFS 共享存储（所有机器可访问）
├── dataset/
│   ├── maps/
│   │   └── nuplan-maps-v1.0/                    # nuPlan 高精地图 (1.4GB)
│   │       ├── us-nv-las-vegas-strip/
│   │       ├── us-pa-pittsburgh-hazelwood/
│   │       ├── sg-one-north/
│   │       └── us-ma-boston/
│   ├── navsim_logs/
│   │   ├── trainval/                            # 1310 个场景日志 .pkl (14GB)
│   │   └── test -> trainval                     # symlink
│   └── sensor_blobs/
│       ├── trainval/                            # 1192 个子目录，每个含传感器帧 (301GB)
│       │   ├── 2021.05.12.22.00.38_veh-35_01008_01518/
│       │   ├── 2021.05.12.22.28.35_veh-35_00620_01164/
│       │   └── ... (共 1192 个)
│       └── test -> trainval                     # symlink
└── exp/
    └── metric_cache/                            # ★ 前处理输出 (1192 个子目录)
        ├── 2021.05.12.22.00.38_veh-35_01008_01518/
        │   └── nonreactive/                     # PDM Score 评估指标缓存
        ├── 2021.05.12.22.28.35_veh-35_00620_01164/
        │   └── nonreactive/
        └── ... (共 1192 个，与 trainval 一一对应)

/root/navsim_workspace/                          ← 各机器本地工作目录
├── navsim/                                      # NAVSIM 源码 (pip install -e .)
├── shard_preprocess.py                          # 分片并行脚本
├── batch_preprocess_v3.py                       # 单机版脚本（已弃用）
├── dataset -> /root/highspeedstorage/jwt/navsim_workspace/dataset
└── exp -> /root/highspeedstorage/jwt/navsim_workspace/exp
```

### 9.3 环境变量

任何使用 NAVSIM 的机器需要设置：

```bash
export NUPLAN_MAP_VERSION="nuplan-maps-v1.0"
export NUPLAN_MAPS_ROOT="/root/highspeedstorage/jwt/navsim_workspace/dataset/maps"
export NAVSIM_EXP_ROOT="/root/highspeedstorage/jwt/navsim_workspace/exp"
export NAVSIM_DEVKIT_ROOT="/root/navsim_workspace/navsim"
export OPENSCENE_DATA_ROOT="/root/highspeedstorage/jwt/navsim_workspace/dataset"
export NUPLAN_DATA_ROOT="/root/highspeedstorage/jwt/navsim_workspace/dataset"
```

### 9.4 验证 metric cache 完整性

```bash
# 1. 确认 log 数量
ls /root/highspeedstorage/jwt/navsim_workspace/exp/metric_cache/ | wc -l
# 期望: 1192

# 2. 确认每个 log 下有 nonreactive 子目录
find /root/highspeedstorage/jwt/navsim_workspace/exp/metric_cache/ -maxdepth 2 -name "nonreactive" | wc -l
# 期望: 1192

# 3. 快速测试训练是否可用
cd ~/navsim_workspace/navsim
python3 navsim/planning/script/run_training.py \
    experiment_name=test_run \
    train_test_split=navtrain \
    agent=transfuser_agent \
    trainer.params.max_epochs=1
```

### 9.5 机器清单

| SSH 命令 | 类型 | CPU | 内存限制 | 角色 |
|----------|------|-----|----------|------|
| `ssh root@112.30.139.26 -p 52290` | 小 | 112 | 8GB | 原始机器 |
| `ssh root@112.30.139.26 -p 50056` | 小 | 112 | 8GB | 分片 worker |
| `ssh root@112.30.139.26 -p 52088` | 小 | 112 | 8GB | 分片 worker |
| `ssh root@112.30.139.26 -p 50445` | 小 | 112 | 8GB | 分片 worker |
| `ssh root@112.30.139.26 -p 50214` | 小 | 112 | 8GB | 分片 worker |
| `ssh root@112.30.139.26 -p 52104` | 小 | 112 | 8GB | 分片 worker |
| `ssh root@112.30.139.26 -p 52209` | 小 | 112 | 8GB | 分片 worker |
| `ssh root@112.30.139.26 -p 51452` | 小 | 112 | 8GB | 分片 worker |
| `ssh root@112.30.139.26 -p 52840` | 小 | 112 | 8GB | 分片 worker |
| `ssh root@112.30.139.26 -p 50631` | 小 | 112 | 8GB | 分片 worker |
| `ssh root@112.30.139.26 -p 51811` | 大 | 160 | 无限制 | SSH 不可达 |
| `ssh root@112.30.139.26 -p 50067` | 大 | 160 | 无限制 | SSH 不可达 |
| `ssh root@112.30.139.26 -p 52187` | 大 | 160 | 无限制 | SSH 不可达 |
| `ssh root@112.30.139.26 -p 51380` | 大 | 160 | 无限制 | SSH 不可达 |

> SSH 公钥（已部署到所有机器）：`ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILoY+7SKioKmVQA3RtXFAmHgaIMz9avjOLTKuRKXkbPu`

### 9.6 后续步骤

1. **验证 metric cache** — 运行一次短训练确认缓存数据可用
2. **下载 history sensors**（如需完整训练）— 32 splits，约 145GB，用 hf-mirror 下载
3. **下载 navtest 数据**（如需评估）— 136 个特定 test log
4. **训练模型** — 使用 `run_training.py` 在有 GPU 的机器上训练
5. **关于 Ray 训练** — 这些容器机器不适合 Ray 分布式训练（环境隔离问题 + 无 GPU），建议使用独立 GPU 机器

---

## 10. 文件清单

远程服务器上的关键文件：

```
~/navsim_workspace/
├── navsim/                         # NAVSIM 源码
├── shard_preprocess.py             # ★ 分片并行前处理脚本（实际采用）
├── batch_preprocess_v3.py          # 单机前处理脚本（ProcessPoolExecutor, 4 workers）
├── ray_cluster_preprocess.py       # Ray 集群版前处理脚本（失败，已弃用）
├── setup_worker.sh                 # Worker 机器环境准备脚本
├── start_ray_workers.sh            # 批量启动 Ray worker 脚本（已弃用）
├── batch_preprocess.py             # v1 顺序处理（已弃用）
├── batch_preprocess_mp.py          # v2 多进程但 OOM（已弃用）
├── download_navtrain_v2.sh         # 数据下载脚本
├── watchdog.sh                     # 下载监控
├── auto_preprocess.sh              # 自动启动前处理
├── preprocess.log                  # 单机前处理日志
├── shard.log                       # 分片前处理日志
├── dataset -> CephFS symlink
└── exp -> CephFS symlink
```
