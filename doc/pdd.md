# 增强 tool 功能
## 增加三个tool
- ‘run_read’,读文件
- ‘run_write’,写文件
- ‘run_edit’,编辑文件
- 以上三个文件操作的命令，必须限制在当前工作目录下
## 命名约束
- 所有 tool 名称必须以 ‘run_’ 开头
- 所有 tool 名称必须是小写
- 将之前 bash 命令也按照这个命名约束进行修改

# 发送给 API 之前，进行消息内容的标准化处理
- 过滤掉 API 规定之外的字符，例如
~~~
content 类型 处理方式 说明 str 直接保留 普通文本消息 
list 过滤 _ 开头的键 移除内部元数据，如 _timestamp 、 _id 等 
其他/None 转为空字符串 容错处理
~~~
设计意图 ：API 无法识别以 _ 开头的字段，必须在发送前过滤掉。
- Claude API 要求每个 tool_use 必须有对应的 tool_result ，否则会报错。
- 合并连续同角色消息，将内容合并（统一转为列表格式后拼接）；不同角色 ：追加为新消息

可以参考如下的 python 逻辑
~~~
def normalize_messages(messages: list) -> list:
    """Clean up messages before sending to the API.

    Three jobs:
    1. Strip internal metadata fields the API doesn't understand
    2. Ensure every tool_use has a matching tool_result (insert placeholder if missing)
    3. Merge consecutive same-role messages (API requires strict alternation)
    """
    cleaned = []
    for msg in messages:
        clean = {"role": msg["role"]}
        if isinstance(msg.get("content"), str):
            clean["content"] = msg["content"]
        elif isinstance(msg.get("content"), list):
            clean["content"] = [
                {k: v for k, v in block.items()
                 if not k.startswith("_")}
                for block in msg["content"]
                if isinstance(block, dict)
            ]
        else:
            clean["content"] = msg.get("content", "")
        cleaned.append(clean)

    # Collect existing tool_result IDs
    existing_results = set()
    for msg in cleaned:
        if isinstance(msg.get("content"), list):
            for block in msg["content"]:
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    existing_results.add(block.get("tool_use_id"))

    # Find orphaned tool_use blocks and insert placeholder results
    for msg in cleaned:
        if msg["role"] != "assistant" or not isinstance(msg.get("content"), list):
            continue
        for block in msg["content"]:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_use" and block.get("id") not in existing_results:
                cleaned.append({"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": block["id"],
                     "content": "(cancelled)"}
                ]})

    # Merge consecutive same-role messages
    if not cleaned:
        return cleaned
    merged = [cleaned[0]]
    for msg in cleaned[1:]:
        if msg["role"] == merged[-1]["role"]:
            prev = merged[-1]
            prev_c = prev["content"] if isinstance(prev["content"], list) \
                else [{"type": "text", "text": str(prev["content"])}]
            curr_c = msg["content"] if isinstance(msg["content"], list) \
                else [{"type": "text", "text": str(msg["content"])}]
            prev["content"] = prev_c + curr_c
        else:
            merged.append(msg)
    return merged
~~~


