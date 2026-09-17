# UaiPedidos Print

Programa local que imprime os pedidos do UaiPedidos direto na impressora térmica,
sem navegador aberto, sem clique e sem a janelinha de impressão. Ele roda em
segundo plano (ícone perto do relógio), verifica os pedidos sozinho e envia as
vias para a bobina, com aviso sonoro de pedido novo.

Funciona para **Windows** e **Mac**, a partir do mesmo código.

## Como funciona (resumo)

1. O programa entra na conta da loja pela API do UaiPedidos (login por token).
2. De tempos em tempos pergunta se há pedidos abertos.
3. Para cada pedido em preparo ainda não impresso, ele carimba no servidor
   (trava anti duplicidade) e, se venceu a corrida, monta a via e imprime.
4. As vias saem com a mesma aparência do painel, usando as preferências da loja
   (margens, largura, fonte e os ajustes avançados).

O cupom é gerado por `src/render.js`, que é a tradução fiel das funções de
impressão do painel do UaiPedidos, para o resultado sair idêntico.

## Rodar em modo de desenvolvimento

Precisa do Node.js 20 ou mais novo instalado.

```
npm install
npm start
```

## Montar os instaladores

### Pelo GitHub (recomendado, não precisa instalar nada no seu PC)

1. Suba esta pasta para um repositório no GitHub.
2. A montagem roda sozinha (arquivo `.github/workflows/build.yml`). Para disparar
   na hora, abra a aba **Actions** e clique em **Run workflow**.
3. Quando terminar, baixe os instaladores em **Artifacts**:
   - `UaiPedidos-Print-windows` contém o `.exe`
   - `UaiPedidos-Print-mac` contém o `.dmg`
4. Para gerar um Release com os dois arquivos, crie uma tag começando com `v`
   (ex: `v1.0.0`).

### Na sua própria máquina

- Windows (num PC com Windows): `npm install` e depois `npm run dist:win`.
- Mac (num Mac): `npm install` e depois `npm run dist:mac`.

Os arquivos aparecem na pasta `dist/`.

> Sem certificado de assinatura, o Windows e o Mac mostram um aviso de segurança
> na primeira execução. É só permitir. Veja `INSTALACAO-WINDOWS.txt` e
> `INSTALACAO-MAC.txt`.

## Estrutura

```
src/
  main.js      processo principal, bandeja, janela, avisos
  preload.js   ponte segura para a tela
  api.js       chamadas à API do UaiPedidos
  render.js    montagem do cupom (igual ao painel)
  poller.js    laço de verificação e fila de impressão
  printer.js   impressão silenciosa
  store.js     configurações e estado, com segredos cifrados
ui/            tela de configuração (HTML, CSS, JS)
assets/        ícones
build/         icon.png usado pela montagem
gen-icons.js   gera os ícones (roda com: node gen-icons.js)
.github/       receita de montagem automática
```

## Observações

- O programa convive com o painel aberto por causa da trava no servidor
  (`marcar_impresso`). Ao usar o UaiPedidos Print, o ideal é desligar a
  impressão automática no painel para não haver disputa de vias.
- A impressora térmica deve estar instalada no sistema, com o tamanho de papel
  (58 mm ou 80 mm) configurado no driver, do mesmo jeito que já é hoje.
