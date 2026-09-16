/**
 * Configuração de Endpoints da API REST
 */
const CONFIG = {
  API_BASE_URL: 'http://127.0.0.1:3000/api/v1',
  
  ENDPOINTS: {
    CAMBIO: '/cambio',          // GET: Captura cotação de câmbio atualizada (USD/BRL)
    ATIVO_POST: '/ativo',       // POST: Envia lista de ativos para avaliação/simulação
    ATIVO_GET: '/ativo',        // GET: Recebe a lista de ativos e status de cada um
    ATIVO_UPDATE: '/ativo'      // PUT/PATCH: Envia lista de ativos aprovados para liquidação
  },

  USE_MOCK_API: false // Alterne para false para conectar ao servidor real
};
