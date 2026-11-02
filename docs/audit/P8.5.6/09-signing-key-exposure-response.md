# P8.5.6 历史签名密钥暴露与撤销

## 暴露事实

旧明文曾存在于 Git 历史。工作树和当前源码已不含该明文。

## 永久撤销

src/trading/trading-pipeline.ts:40 保存历史密钥的 SHA-256 指纹：

~~~text
37ca7d242a79b5dfa5c774b0e43510a05d6ffc965e65b00d0c7ae5ccccc08c69
~~~

签发和验证统一经过 resolvePipelineSecret。指纹命中时返回【密钥已撤销】，不再产生或接受凭证。

## 测试

tests/unit/p8-5-6-signing-key-revocation.test.ts:74

- 合成 secret 加入撤销指纹。
- signPipelineCredential 拒绝。
- 未撤销 secret 正常验证。

结论：旧密钥在运行时永久撤销；Git 历史中的泄露事实不能删除，但其密码学效力已失效。
