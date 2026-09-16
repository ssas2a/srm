document.addEventListener('DOMContentLoaded', () => {
  let exchangeRate = 5.3650;
  let activeAtivos = [];

  // Elementos do DOM
  const usdRateEl = document.getElementById('usdRate');
  const btnFetchCambio = document.getElementById('btnFetchCambio');
  const formNovoAtivo = document.getElementById('formNovoAtivo');
  const btnEnviarAvaliacao = document.getElementById('btnEnviarAvaliacao');
  const btnCarregarAtivos = document.getElementById('btnCarregarAtivos');
  const tableBody = document.getElementById('tableBody');
  const emptyMsg = document.getElementById('emptyMsg');
  const selectAllCheckbox = document.getElementById('selectAllCheckbox');
  const btnLiquidarSelecionados = document.getElementById('btnLiquidarSelecionados');
  function renderCambio() {
    usdRateEl.textContent = `R$ ${exchangeRate.toFixed(4)}`;
  }

  let cambioEmAtualizacao = false;

  async function atualizarCambio(mostrarFeedback = false) {
    if (cambioEmAtualizacao) return;

    cambioEmAtualizacao = true;
    btnFetchCambio.disabled = true;
    if (mostrarFeedback) btnFetchCambio.textContent = 'Buscando...';

    try {
      if (CONFIG.USE_MOCK_API) {
        await new Promise(r => setTimeout(r, 400));
        exchangeRate = Number((5.30 + Math.random() * 0.15).toFixed(4));
      } else {
        const response = await fetch(`${CONFIG.API_BASE_URL}${CONFIG.ENDPOINTS.CAMBIO}`);
        if (!response.ok) throw new Error('Falha ao obter cotação.');
        const data = await response.json();
        exchangeRate = parseFloat(data.rate || data.valor);
      }

      renderCambio();
      if (mostrarFeedback) {
        alert(`Câmbio atualizado com sucesso: R$ ${exchangeRate.toFixed(4)}`);
      }
    } catch (err) {
      if (mostrarFeedback) alert(`Erro no endpoint cambio: ${err.message}`);
      else console.error('Erro ao atualizar câmbio automaticamente:', err);
    } finally {
      cambioEmAtualizacao = false;
      btnFetchCambio.disabled = false;
      if (mostrarFeedback) btnFetchCambio.textContent = 'Puxar Câmbio';
    }
  }

  // 1. ENDPOINT: CÂMBIO (GET)
  btnFetchCambio.addEventListener('click', () => atualizarCambio(true));
  atualizarCambio();
  setInterval(() => atualizarCambio(), 30000);

  // 2. ENDPOINT: ATIVO (POST) - Enviar lista para avaliação
  formNovoAtivo.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const novoAtivo = {
      cliente: document.getElementById('cliente').value.trim(),
      idempotencyKey: crypto.randomUUID(),
      tipo: document.getElementById('tipo').value,
      valorFace: parseFloat(document.getElementById('valorFace').value),
      moeda: document.getElementById('moeda').value,
      vencimento: document.getElementById('vencimento').value
    };

    btnEnviarAvaliacao.disabled = true;
    btnEnviarAvaliacao.textContent = 'Enviando...';

    try {
      if (CONFIG.USE_MOCK_API) {
        await new Promise(r => setTimeout(r, 500));
        const criado = {
          id: `ATV-${Math.floor(1000 + Math.random() * 9000)}`,
          ...novoAtivo,
          status: 'AVALIADO',
          selecionado: false
        };
        activeAtivos.push(criado);
      } else {
        const response = await fetch(`${CONFIG.API_BASE_URL}${CONFIG.ENDPOINTS.ATIVO_POST}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify([novoAtivo])
        });
        if (!response.ok) throw new Error('Erro ao enviar ativos para avaliação.');
        const ret = await response.json();
        const listaRetornada = Array.isArray(ret) ? ret : [ret];
        listaRetornada.forEach(item => {
          activeAtivos.push({ ...item, selecionado: false });
        });
      }

      renderTabelaAtivos();
      alert('Ativo enviado para avaliação!');
    } catch (err) {
      alert(`Erro no endpoint ativo (POST): ${err.message}`);
    } finally {
      btnEnviarAvaliacao.disabled = false;
      btnEnviarAvaliacao.textContent = '+ Enviar para Avaliação';
    }
  });

  // 3. ENDPOINT: ATIVO (GET) - Consultar lista de ativos e status
  btnCarregarAtivos.addEventListener('click', carregarAtivosGET);

  async function carregarAtivosGET() {
    btnCarregarAtivos.disabled = true;

    try {
      if (CONFIG.USE_MOCK_API) {
        await new Promise(r => setTimeout(r, 400));
        if (activeAtivos.length === 0) {
          activeAtivos = [
            { id: 'ATV-1001', tipo: 'DUPLICATA', valorFace: 50000, moeda: 'BRL', vencimento: '2026-10-15', status: 'AVALIADO', selecionado: false },
            { id: 'ATV-1002', tipo: 'CHEQUE', valorFace: 12000, moeda: 'USD', vencimento: '2026-11-01', status: 'AVALIADO', selecionado: false }
          ];
        }
      } else {
        const response = await fetch(`${CONFIG.API_BASE_URL}${CONFIG.ENDPOINTS.ATIVO_GET}`);
        if (!response.ok) throw new Error('Falha ao carregar ativos.');
        const data = await response.json();
        activeAtivos = data.map(item => ({ ...item, selecionado: false }));
      }

      renderTabelaAtivos();
    } catch (err) {
      alert(`Erro no endpoint ativo (GET): ${err.message}`);
    } finally {
      btnCarregarAtivos.disabled = false;
    }
  }

  // 4. ENDPOINT: ATIVO (UPDATE) - Liquidar ativos selecionados ou individuais
  async function liquidarAtivos(ativosParaLiquidar) {
    if (ativosParaLiquidar.length === 0) return;

    const payload = ativosParaLiquidar.map(a => ({
      id: a.id,
      status: 'LIQUIDADO'
    }));

    try {
      if (CONFIG.USE_MOCK_API) {
        await new Promise(r => setTimeout(r, 600));
        ativosParaLiquidar.forEach(a => a.status = 'LIQUIDADO');
      } else {
        const response = await fetch(`${CONFIG.API_BASE_URL}${CONFIG.ENDPOINTS.ATIVO_UPDATE}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (!response.ok) throw new Error('Falha ao liquidar ativos.');
      }

      alert(`${ativosParaLiquidar.length} ativo(s) liquidado(s) com sucesso!`);
      renderTabelaAtivos();
    } catch (err) {
      alert(`Erro no endpoint ativo (UPDATE): ${err.message}`);
    }
  }

  // Habilitar / Desabilitar Seleção Global (Select All)
  selectAllCheckbox.addEventListener('change', (e) => {
    const isChecked = e.target.checked;
    activeAtivos.forEach(a => {
      if (a.status !== 'LIQUIDADO') {
        a.selecionado = isChecked;
      }
    });
    renderTabelaAtivos();
  });

  // Botão: Liquidar Todos os Selecionados
  btnLiquidarSelecionados.addEventListener('click', () => {
    const selecionados = activeAtivos.filter(a => a.selecionado && a.status !== 'LIQUIDADO');
    if (selecionados.length === 0) {
      alert('Selecione ao menos um ativo pendente para liquidar.');
      return;
    }
    liquidarAtivos(selecionados);
  });

  // Renderizar a Lista de Ativos
  function renderTabelaAtivos() {
    if (activeAtivos.length === 0) {
      tableBody.innerHTML = '';
      emptyMsg.style.display = 'block';
      btnLiquidarSelecionados.disabled = true;
      selectAllCheckbox.checked = false;
      return;
    }

    emptyMsg.style.display = 'none';

    tableBody.innerHTML = activeAtivos.map(ativo => `
      <tr class="${ativo.status === 'LIQUIDADO' ? 'row-liquidated' : ''}">
        <td>
          <input type="checkbox" 
            class="ativo-checkbox" 
            data-id="${ativo.id}" 
            ${ativo.selecionado ? 'checked' : ''} 
            ${ativo.status === 'LIQUIDADO' ? 'disabled' : ''}>
        </td>
        <td class="font-mono">${ativo.id}</td>
        <td>${ativo.tipo}</td>
        <td>${ativo.moeda}</td>
        <td>${ativo.valorFace.toLocaleString('pt-BR', {minimumFractionDigits: 2})}</td>
        <td>${ativo.vencimento}</td>
        <td>R$ ${(ativo.valorPresenteBrl ?? 0).toLocaleString('pt-BR', {minimumFractionDigits: 2})}</td>
        <td>US$ ${(ativo.valorPresenteUsd ?? 0).toLocaleString('pt-BR', {minimumFractionDigits: 2})}</td>
        <td>${ativo.moeda} ${(ativo.desagio ?? 0).toLocaleString('pt-BR', {minimumFractionDigits: 2})}</td>
        <td>${(ativo.cotacaoDolar ?? 0).toLocaleString('pt-BR', {minimumFractionDigits: 4})}</td>
        <td>
          <span class="badge ${ativo.status === 'LIQUIDADO' ? 'badge-success' : 'badge-warning'}">
            ${ativo.status}
          </span>
        </td>
        <td>
          <button class="btn btn-sm btn-success btn-liquidar-single" 
            data-id="${ativo.id}" 
            ${ativo.status === 'LIQUIDADO' ? 'disabled' : ''}>
            ${ativo.status === 'LIQUIDADO' ? 'Liquidado' : 'Liquidar'}
          </button>
        </td>
      </tr>
    `).join('');

    // Eventos dos checkboxes individuais
    document.querySelectorAll('.ativo-checkbox').forEach(chk => {
      chk.addEventListener('change', (e) => {
        const id = e.target.getAttribute('data-id');
        const item = activeAtivos.find(a => a.id === id);
        if (item) item.selecionado = e.target.checked;
        
        // Atualiza estado do botão de ação em massa
        const temSelecionados = activeAtivos.some(a => a.selecionado && a.status !== 'LIQUIDADO');
        btnLiquidarSelecionados.disabled = !temSelecionados;
      });
    });

    // Eventos dos botões de liquidação individual
    document.querySelectorAll('.btn-liquidar-single').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.target.getAttribute('data-id');
        const item = activeAtivos.find(a => a.id === id);
        if (item) liquidarAtivos([item]);
      });
    });

    const temPendentesSelecionados = activeAtivos.some(a => a.selecionado && a.status !== 'LIQUIDADO');
    btnLiquidarSelecionados.disabled = !temPendentesSelecionados;
  }

  renderCambio();
});
