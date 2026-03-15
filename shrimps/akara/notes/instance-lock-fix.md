# 多实例锁修复方案

**问题**: Akara/Brandeis/Donovan 重复启动，轰炸频道
**任务**: #t28

## 方案选项

### 方案 A: PID 文件锁（本地单节点）
启动时写入 PID 文件，检查已有进程是否在运行。
```bash
# 启动脚本加锁
if [ -f /tmp/akara.lock ]; then
  pid=$(cat /tmp/akara.lock)
  if ps -p $pid > /dev/null; then
    echo "已有实例运行，退出"
    exit 1
  fi
fi
echo $$ > /tmp/akara.lock
```

### 方案 B: 服务端状态检查（推荐）
启动前查询 server 状态，如果已有同 agent online，则不启动。
利用 `list_server` 接口检查 agent 状态。

### 方案 C: 启动脚本去重
在 supervisor/systemd 层配置单实例限制。

## 下一步
需要看 Jwt2077 的启动脚本是怎么写的，才能定具体方案。
