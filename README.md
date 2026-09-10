# Oferta Express Bridge

Bridge separado para o **Oferta Express**.

Fluxo:

`App -> Oferta Express (Render) -> Bridge -> Chromium/Playwright -> Shopee`

O projeto principal **não precisa ser alterado**.  
No Render do Oferta Express principal, basta configurar:

- `PC_BRIDGE_URL=https://SEU-BRIDGE.onrender.com`
- `PC_BRIDGE_TOKEN=O_MESMO_TOKEN_DO_BRIDGE`

No serviço Bridge, configure:

- `BRIDGE_TOKEN=O_MESMO_TOKEN`

## Endpoints

### GET /health
Teste simples do servidor.

### POST /resolve
Header:

`Authorization: Bearer SEU_TOKEN`

Body:

```json
{
  "url": "https://shopee.com.br/..."
}
```

## Deploy no Render

1. Crie um repositório GitHub novo chamado `oferta-express-bridge`.
2. Envie todos os arquivos desta pasta para a raiz do repositório.
3. No Render: **New > Web Service**.
4. Conecte o repositório.
5. Em **Language**, escolha `Docker`.
6. Escolha o plano `Free`, caso esteja disponível para sua conta/workspace.
7. Adicione a variável `BRIDGE_TOKEN`.
8. Faça o deploy.
9. Abra `https://SEU-BRIDGE.onrender.com/health`.
10. No Render do Oferta Express principal, configure:
    - `PC_BRIDGE_URL=https://SEU-BRIDGE.onrender.com`
    - `PC_BRIDGE_TOKEN` com o mesmo token.
11. Reinicie/redeploy o Oferta Express principal.
12. Faça uma busca pelo app.

## Observação

A Shopee pode aplicar bloqueios/validações também a navegadores em datacenters.
Este Bridge usa Chromium real para melhorar a compatibilidade, mas não há garantia
de que todo IP de hospedagem gratuita será aceito permanentemente.
