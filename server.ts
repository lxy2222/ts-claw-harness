const main = () => {
  console.log("欢迎来到服务器");
  // todo: 增加鉴权逻辑
  const user: { id: string } | null = null; // TODO: 从请求上下文/Token 中解析出当前用户
  if (user == null) { console.log("Forbidden!"); return; }
}

main();