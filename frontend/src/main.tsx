import { cloneElement, useEffect, useId, useState, type FormEvent, type ReactElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type Conta = { nome: string; celular: string; papel: 'CLIENTE' | 'ENGENHEIRO' | 'ADMIN' };
type Sessao = { conta: Conta; token: string; expiraEm: string };
type Situacao = 'RECEBIDO' | 'INFORMACOES' | 'MARCADO' | 'CONCLUIDO';
type Lugar = { municipio: string; comunidade?: string; local: string };
type Pedido = Lugar & {
  id: string; servico: string; descricao: string; link?: string; situacao: Situacao;
  cliente: Conta; visita?: { horario: string };
  mensagens: { id: string; texto: string; autor: Conta['papel'] }[];
};
type Visita = { id: string; horario: string; pedido: Lugar & { cliente: { nome: string } } };
type FalhaDados = { message?: string; campos?: Record<string, string> };
const apiUrl = (import.meta.env.VITE_API_URL || 'http://localhost:3000').replace(/\/$/, '');
const acessoProfissionalLegado = import.meta.env.VITE_ACESSO_PROFISSIONAL_LEGADO === '1';
const rotulos: Record<Situacao, string> = {
  RECEBIDO: 'Pedido recebido', INFORMACOES: 'Precisamos de informações',
  MARCADO: 'Visita marcada', CONCLUIDO: 'Concluído',
};
const servicos = ['Topografia', 'CAR', 'INCRA', 'Projetos', 'Não sei qual serviço preciso'];
const servicosCapa = [
  ['Topografia', 'Levantamento e medições do terreno.'],
  ['CAR', 'Demandas do Cadastro Ambiental Rural.'],
  ['Serviços relacionados ao INCRA', 'Demandas de imóveis rurais relacionadas ao INCRA.'],
  ['Projetos', 'Elaboração de projetos de engenharia civil.'],
];
const etapas = [
  ['Envie seu pedido', 'Escolha o serviço e diga onde fica o imóvel.'],
  ['Acompanhe a resposta', 'Consulte seus pedidos e responda se o engenheiro pedir detalhes.'],
  ['Veja o dia e a hora da visita', 'O engenheiro define o horário e publica a confirmação aqui.'],
];
const horas = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0') + ':00');
const fuso = 'America/Sao_Paulo';
const dataISO = new Intl.DateTimeFormat('sv-SE', { timeZone: fuso });
const dataCurta = new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, dateStyle: 'long' });
const horaCurta = new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, timeStyle: 'short' });
const diaDe = (horario: string) => dataISO.format(new Date(horario));
const horarioDe = (horario: string) => horaCurta.format(new Date(horario));
const dataDe = (dia: string) => dataCurta.format(new Date(dia + 'T12:00:00-03:00'));
const lugarDe = (lugar: Lugar) => [lugar.local, lugar.comunidade, lugar.municipio].filter(Boolean).join(' · ');

class Falha extends Error {
  constructor(message: string, readonly campos: Record<string,string> = {}, readonly status = 0) { super(message); }
}

async function api<T>(rota: string, token?: string, dados?: object, signal?: AbortSignal): Promise<T> {
  let resposta: Response;
  try {
    resposta = await fetch(apiUrl + rota, {
      method: dados ? 'POST' : 'GET',
      headers: { ...(token && { Authorization: 'Bearer ' + token }), ...(dados && { 'Content-Type': 'application/json' }) },
      body: dados && JSON.stringify(dados),
      signal,
    });
  } catch {
    throw new Falha('Não foi possível conectar. Confira a conexão e tente novamente.');
  }
  const corpo = await resposta.json().catch(() => ({}));
  if (!resposta.ok) {
    const erro = corpo as FalhaDados;
    throw new Falha(erro.message || 'Não foi possível completar a ação.', erro.campos, resposta.status);
  }
  return corpo as T;
}

function lerSessao(): Sessao | null {
  try { return JSON.parse(sessionStorage.getItem('agenda.sessao') || 'null'); }
  catch { return null; }
}

function Campo({ nome, rotulo, erro, children }: {
  nome: string; rotulo: string; erro?: Falha;
  children: ReactElement<{ id?: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string }>;
}) {
  const id = useId();
  const mensagem = erro?.campos[nome];
  return <div className={mensagem ? 'campo invalido' : 'campo'}>
    <label htmlFor={id}>{rotulo}</label>
    {cloneElement(children, { id, 'aria-invalid': mensagem ? true : undefined, 'aria-describedby': [children.props['aria-describedby'], mensagem && id + '-erro'].filter(Boolean).join(' ') || undefined })}
    {mensagem && <small id={id + '-erro'}>{mensagem}</small>}
  </div>;
}

function Formulario({ titulo, enviar, children }: {
  titulo: string; enviar: (dados: Record<string,string>) => Promise<void>;
  children: (erro?: Falha) => ReactNode;
}) {
  const [erro, setErro] = useState<Falha>();
  const [ocupado, setOcupado] = useState(false);
  async function submit(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    if (ocupado) return;
    const dados = Object.fromEntries([...new FormData(evento.currentTarget)].map(([k,v]) => [k, String(v)]).filter(([,v]) => v.trim())) as Record<string,string>;
    setErro(undefined);
    setOcupado(true);
    try { await enviar(dados); }
    catch (e) { setErro(e instanceof Falha ? e : new Falha('Ocorreu um erro. Tente novamente.')); }
    finally { setOcupado(false); }
  }
  return <form onSubmit={submit}>
    <fieldset disabled={ocupado} aria-busy={ocupado}>{children(erro)}
      {erro && <p className="erro retorno" role="alert">{erro.message}</p>}
      <button className="primario" type="submit">{ocupado ? 'Enviando…' : titulo}</button>
    </fieldset>
  </form>;
}

function Acesso({ entrar, profissional, destino, negado, irParaPedidos, cadastro = false, alternarCadastro }: {
  entrar: (sessao: Sessao) => void;
  profissional?: boolean;
  destino?: 'novo' | 'pedidos';
  negado?: boolean;
  irParaPedidos?: () => void;
  cadastro?: boolean;
  alternarCadastro?: (cadastro: boolean) => void;
}) {
  const [celular, setCelular] = useState('');
  const [ajuda, setAjuda] = useState(false);
  return <section className="painel estreito acesso painel-formulario">
    <h1>{profissional ? 'Entrar como profissional' : cadastro ? 'Crie sua conta' : 'Acesso do cliente'}</h1>
    <p>{profissional ? 'Use o celular com DDD e a senha da sua conta profissional ou de administração.' : destino === 'novo'
      ? 'Entre ou crie uma conta para continuar com seu pedido de visita.'
      : 'Entre ou crie uma conta para acessar seus pedidos.'}</p>
    {negado && <div className="retorno erro acesso-negado">
      <p role="alert">Esta conta é de cliente. O painel está disponível apenas para a conta do engenheiro.</p>
      <button className="secundario" onClick={irParaPedidos}>Ir para meus pedidos</button>
    </div>}
    <Formulario key={String(cadastro)} titulo={cadastro ? 'Criar conta' : 'Entrar'} enviar={async dados => entrar(await api<Sessao>(cadastro ? '/auth/cadastro' : '/auth/login', undefined, dados))}>
      {erro => <>
        {cadastro && <Campo nome="nome" rotulo="Nome" erro={erro}><input name="nome" autoComplete="name" required minLength={2} maxLength={80}/></Campo>}
        <Campo nome="celular" rotulo="Celular com DDD" erro={erro}><input name="celular" type="tel" autoComplete="username" required maxLength={20} value={celular} onChange={evento => setCelular(evento.target.value)} placeholder="(84) 99999-9999"/></Campo>
        <div>
          <Campo nome="senha" rotulo="Senha" erro={erro}><input name="senha" type="password" autoComplete={cadastro ? 'new-password' : 'current-password'} required minLength={cadastro ? 15 : 8} maxLength={128} aria-describedby={cadastro ? 'ajuda-senha' : undefined}/></Campo>
          {cadastro && <small className="suave" id="ajuda-senha">Use pelo menos 15 caracteres. Pode ser uma frase fácil de lembrar.</small>}
        </div>
        {cadastro && erro?.status === 409 && <div className="acoes">
          <button type="button" className="secundario" onClick={() => alternarCadastro?.(false)}>Entrar com este celular</button>
          <button type="button" className="texto" onClick={() => setAjuda(true)}>Buscar ajuda</button>
        </div>}
      </>}
    </Formulario>
    {!profissional && <button className="texto alternar-acesso" onClick={() => alternarCadastro?.(!cadastro)}>{cadastro ? 'Já tenho conta' : 'Criar conta'}</button>}
    {!profissional && !cadastro && <button className="texto alternar-acesso" aria-expanded={ajuda} onClick={() => setAjuda(!ajuda)}>Preciso de ajuda para entrar</button>}
    {!profissional && ajuda && <p className="retorno" role="status">Se você não lembra a senha ou perdeu acesso ao celular, fale com o engenheiro pelo canal que já usa para falar com ele. Não envie sua senha.</p>}
  </section>;
}

type RegistroPublico = { nomeCompleto: string; titulo: string; creaUf: string; registro: string; revisadoEm: string | null };
type EstadoProfissional = 'EM_ANALISE' | 'APROVADO' | 'REJEITADO';
type PerfilProfissional = RegistroPublico & { situacao: EstadoProfissional; autorizaPublicacao: boolean };
type Revisao = PerfilProfissional & { contaId: string; conta: { celular: string }; revisor: { nome: string } | null };
const consultaOficial = 'https://consultaprofissional.confea.org.br/';
const ufs = 'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ');
const situacoesProfissionais: Record<EstadoProfissional, string> = {
  EM_ANALISE: 'Em análise', APROVADO: 'Aprovado', REJEITADO: 'Rejeitado',
};

function Capa({ pedir, acompanhar }: { pedir: () => void; acompanhar: () => void }) {
  const [perfil, setPerfil] = useState<RegistroPublico | null>(null);
  useEffect(() => {
    if (acessoProfissionalLegado) return;
    const controller = new AbortController();
    void api<{ perfil: RegistroPublico | null }>('/profissionais/publico', undefined, undefined, controller.signal)
      .then(({ perfil }) => setPerfil(perfil)).catch(() => {});
    return () => controller.abort();
  }, []);
  return <>
    <section className="hero">
      <div className="hero-conteudo">
        <h1>Solicite uma visita técnica</h1>
        <p>Conte o que você precisa e acompanhe por aqui quando a visita for marcada.</p>
        <div className="acoes"><button className="primario" onClick={pedir}>Pedir atendimento</button><button className="secundario" onClick={acompanhar}>Acompanhar meu pedido</button></div>
      </div>
      <picture className="hero-foto">
        <source media="(max-width: 767px)" srcSet="/topografia-rural-mobile.webp"/>
        <img src="/topografia-rural.webp" alt="Estação total em um tripé de topografia em área rural" width="1200" height="800" fetchPriority="high"/>
      </picture>
    </section>
    <section className="secao-capa">
      <h2>Serviços</h2>
      <div className="servicos">{servicosCapa.map(([nome, descricao]) => <article key={nome}><h3>{nome}</h3><p>{descricao}</p></article>)}</div>
    </section>
    <section className="secao-capa painel quem-atende">
      <h2>Quem atende</h2>
      {perfil ? <div className="identidade-profissional">
        <div>
          <h3>{perfil.nomeCompleto}</h3>
          <p className="titulo-profissional">{perfil.titulo}</p>
          <p className="registro-profissional">CREA-{perfil.creaUf} <strong>{perfil.registro}</strong></p>
        </div>
        <div className="consulta-profissional">
          {perfil.revisadoEm && <p>Registro conferido pela Agenda em {dataCurta.format(new Date(perfil.revisadoEm))}.</p>}
          <a className="secundario" href={consultaOficial} target="_blank" rel="noreferrer">Consultar registro no Confea</a>
        </div>
      </div> : <p>O perfil profissional aparece aqui após a conferência e a autorização de publicação.</p>}
    </section>
    <section className="secao-capa">
      <h2>Como funciona</h2>
      <ol className="fluxo">{etapas.map(([titulo, descricao]) => <li key={titulo}><h3>{titulo}</h3><p>{descricao}</p></li>)}</ol>
    </section>
  </>;
}

function FormularioProfissional({ autenticado, enviar }: { autenticado: boolean; enviar: (dados: Record<string, string>) => Promise<void> }) {
  return <section className="painel estreito painel-formulario">
    <h1>{autenticado ? 'Verificar minha conta profissional' : 'Solicitar cadastro profissional'}</h1>
    <p>Preencha os dados como aparecem no registro do Confea/CREA. O acesso aos pedidos depende de revisão.</p>
    <Formulario titulo="Enviar solicitação" enviar={enviar}>{erro => <>
      <Campo nome="nome" rotulo="Nome completo" erro={erro}><input name="nome" autoComplete="name" minLength={3} maxLength={80} required/></Campo>
      {!autenticado && <>
        <Campo nome="celular" rotulo="Celular com DDD" erro={erro}><input name="celular" type="tel" autoComplete="username" maxLength={20} required/></Campo>
        <Campo nome="senha" rotulo="Senha (15 caracteres ou mais)" erro={erro}><input name="senha" type="password" autoComplete="new-password" minLength={15} maxLength={128} required/></Campo>
      </>}
      <Campo nome="titulo" rotulo="Título profissional conforme o registro" erro={erro}><input name="titulo" minLength={2} maxLength={120} required/></Campo>
      <Campo nome="creaUf" rotulo="CREA-UF" erro={erro}><select name="creaUf" required defaultValue=""><option value="" disabled>Selecione a UF</option>{ufs.map(uf => <option key={uf}>{uf}</option>)}</select></Campo>
      <Campo nome="registro" rotulo="Número de registro" erro={erro}><input name="registro" maxLength={40} required/></Campo>
      <label className="confirmacao"><input name="autorizaPublicacao" type="checkbox"/> Autorizo publicar meu nome, título e registro na capa após a aprovação.</label>
    </>}</Formulario>
  </section>;
}

function PainelRevisao({ revisoes, revisar }: { revisoes: Revisao[]; revisar: (id: string, dados: object) => Promise<void> }) {
  return <>
    <p>Confira nome, título e registro ativo na fonte oficial. Confirme a identidade por um canal obtido independentemente do formulário.</p>
    <p><a href={consultaOficial} target="_blank" rel="noreferrer">Abrir consulta oficial do Confea</a></p>
    {!revisoes.length && <p className="painel">Nenhuma solicitação recebida.</p>}
    {revisoes.map(item => <article key={item.contaId} className="painel cartao">
      <div className="linha"><h2>{item.nomeCompleto}</h2><span className="estado">{situacoesProfissionais[item.situacao]}</span></div>
      <p>{item.titulo} · CREA-{item.creaUf} {item.registro}</p>
      <p>Celular informado no cadastro: {item.conta.celular}</p>
      {item.revisor && item.revisadoEm && <p>Revisado por {item.revisor.nome} em {dataCurta.format(new Date(item.revisadoEm))}.</p>}
      {item.situacao === 'EM_ANALISE' && <Formulario titulo="Registrar decisão" enviar={dados => revisar(item.contaId, {
        decisao: dados.decisao, dadosConferidos: dados.dadosConferidos === 'on',
        titularConfirmado: dados.titularConfirmado === 'on', fonteOficial: dados.fonteOficial, metodoIdentidade: dados.metodoIdentidade,
      })}>{erro => <>
        <label className="confirmacao"><input type="checkbox" name="dadosConferidos"/> Conferi nome, título e situação do registro na fonte oficial.</label>
        <Campo nome="fonteOficial" rotulo="Fonte oficial" erro={erro}><select name="fonteOficial" defaultValue=""><option value="">Selecione a fonte</option><option value="CONFEA">Consulta Confea</option><option value="CREA">CREA responsável</option></select></Campo>
        <label className="confirmacao"><input type="checkbox" name="titularConfirmado"/> Confirmei por canal independente que a pessoa é titular do registro.</label>
        <Campo nome="metodoIdentidade" rotulo="Canal de verificação independente" erro={erro}><select name="metodoIdentidade" defaultValue=""><option value="">Selecione o canal</option><option value="CONTATO_INSTITUCIONAL">Contato institucional obtido de fonte independente</option><option value="VERIFICACAO_PRESENCIAL">Verificação presencial</option><option value="CONFIRMACAO_PELO_CREA">Confirmação pelo CREA</option></select></Campo>
        <Campo nome="decisao" rotulo="Decisão" erro={erro}><select name="decisao" required defaultValue=""><option value="" disabled>Selecione a decisão</option><option value="APROVADO">Aprovar</option><option value="REJEITADO">Rejeitar</option></select></Campo>
      </>}</Formulario>}
    </article>)}
  </>;
}

function NovoPedido({ enviar }: { enviar: (dados: object) => Promise<void> }) {
  return <section className="painel estreito painel-formulario">
    <h1>Pedir atendimento</h1>
    <p>Informe o serviço e o local. O engenheiro vai definir o dia e o horário.</p>
    <Formulario titulo="Enviar pedido" enviar={enviar}>{erro => <>
      <Campo nome="servico" rotulo="Tipo de serviço" erro={erro}><select name="servico" required defaultValue=""><option value="" disabled>Selecione um serviço</option>{servicos.map(s => <option key={s}>{s}</option>)}</select></Campo>
      <Campo nome="municipio" rotulo="Em qual município fica o imóvel?" erro={erro}><input name="municipio" required minLength={2} maxLength={90}/></Campo>
      <Campo nome="comunidade" rotulo="Comunidade (opcional)" erro={erro}><input name="comunidade" minLength={2} maxLength={100}/></Campo>
      <Campo nome="local" rotulo="Como chegar?" erro={erro}><input name="local" required minLength={3} maxLength={160} placeholder="Comunidade, endereço ou ponto de referência"/></Campo>
      <Campo nome="descricao" rotulo="O que você precisa?" erro={erro}><textarea name="descricao" required minLength={3} maxLength={400} rows={3}/></Campo>
      <Campo nome="link" rotulo="Link de localização (opcional)" erro={erro}><input type="url" name="link" maxLength={500} placeholder="https://"/></Campo>
    </>}</Formulario>
  </section>;
}

type Acao = 'informacoes' | 'respostas' | 'conclusao' | 'visitas';
function CartaoPedido({ pedido, engenheiro, mudar }: { pedido: Pedido; engenheiro: boolean; mudar: (acao: Acao, dados: object) => Promise<void> }) {
  const [acao, setAcao] = useState<Acao>();
  const aberto = pedido.situacao === 'RECEBIDO' || pedido.situacao === 'INFORMACOES';
  async function enviar(operacao: Acao, dados: object) {
    await mudar(operacao, dados);
    setAcao(undefined);
  }
  return <article className="painel cartao">
    <div className="linha"><h2>{pedido.servico}</h2><span className={'estado ' + pedido.situacao}>{rotulos[pedido.situacao]}</span></div>
    {pedido.visita && <div className="horario">
      <span>{pedido.situacao === 'CONCLUIDO' ? 'Horário registrado da visita' : 'Dia e hora da visita'}</span>
      <time dateTime={pedido.visita.horario}>{dataDe(diaDe(pedido.visita.horario))} às {horarioDe(pedido.visita.horario)}</time>
      <span>Horário de Brasília</span>
    </div>}
    {!engenheiro && pedido.situacao === 'RECEBIDO' && <p className="orientacao">Aguarde a resposta do engenheiro e volte aqui para acompanhar.</p>}
    {!engenheiro && pedido.situacao === 'INFORMACOES' && <div className="resposta-acesso">
      <p>Veja a mensagem do engenheiro e envie os detalhes que ele pediu.</p>
      {acao !== 'respostas' && <button className="primario" onClick={() => setAcao('respostas')}>Responder</button>}
    </div>}
    {engenheiro && <p><strong>{pedido.cliente.nome}</strong> · <a href={'tel:+55' + pedido.cliente.celular}>{pedido.cliente.celular.replace(/^(\d{2})(\d{5})(\d{4})$/, '($1) $2-$3')}</a></p>}
    <p>{lugarDe(pedido)}</p>
    <p>{pedido.descricao}</p>
    {pedido.link && <p><a href={pedido.link} target="_blank" rel="noreferrer">Abrir link de localização</a></p>}
    {!!pedido.mensagens.length && <ul className="conversa" aria-label="Mensagens do pedido">{pedido.mensagens.map(m => <li key={m.id}><strong>{m.autor === 'ENGENHEIRO' ? 'Engenheiro' : 'Cliente'}</strong><p>{m.texto}</p></li>)}</ul>}
    {!engenheiro && pedido.situacao === 'INFORMACOES' && acao === 'respostas' && <div className="editor">
      <Formulario titulo="Enviar resposta" enviar={dados => enviar('respostas', dados)}>{erro =>
        <Campo nome="texto" rotulo="Sua resposta" erro={erro}><textarea name="texto" rows={2} required minLength={3} maxLength={400} autoFocus/></Campo>
      }</Formulario>
      <button className="texto" onClick={() => setAcao(undefined)}>Cancelar</button>
    </div>}
    {engenheiro && pedido.situacao !== 'CONCLUIDO' && <div className="acoes">
      {aberto && <><button className="primario" onClick={() => setAcao('visitas')}>Marcar visita</button><button className="secundario" onClick={() => setAcao('informacoes')}>Pedir informações</button></>}
      <button className="secundario" onClick={() => setAcao('conclusao')}>Concluir atendimento</button>
    </div>}
    {engenheiro && acao && <div className="editor">
      {acao === 'visitas' && <Formulario titulo="Confirmar visita" enviar={dados => enviar('visitas', { pedidoId: pedido.id, ...dados })}>{erro =>
        <div className="filtros">
          <Campo nome="dia" rotulo="Dia da visita" erro={erro}><input type="date" name="dia" min={dataISO.format()} required/></Campo>
          <Campo nome="hora" rotulo="Hora de Brasília" erro={erro}><select name="hora" required defaultValue=""><option value="" disabled>Selecione</option>{horas.map(hora => <option key={hora}>{hora}</option>)}</select></Campo>
        </div>
      }</Formulario>}
      {acao === 'informacoes' && <Formulario titulo="Enviar mensagem" enviar={dados => enviar('informacoes', dados)}>{erro =>
        <Campo nome="texto" rotulo="O que o cliente precisa informar?" erro={erro}><textarea name="texto" rows={2} required minLength={3} maxLength={400}/></Campo>
      }</Formulario>}
      {acao === 'conclusao' && <Formulario titulo="Confirmar conclusão" enviar={dados => enviar('conclusao', dados)}>{() => <p>Confirme para encerrar este atendimento.</p>}</Formulario>}
      <button className="texto" onClick={() => setAcao(undefined)}>Cancelar</button>
    </div>}
  </article>;
}

function Agenda({ visitas }: { visitas: Visita[] }) {
  const [dia, setDia] = useState(dataISO.format());
  const proxima = visitas.find(v => new Date(v.horario).getTime() >= Date.now());
  const dias = [...new Set(visitas.map(v => diaDe(v.horario)))];
  const doDia = visitas.filter(v => diaDe(v.horario) === dia);
  return <>
    <section className="destaque">
      <h2>Próximo compromisso</h2>
      {proxima ? <><p className="destaque-hora">{dataDe(diaDe(proxima.horario))} às {horarioDe(proxima.horario)}</p><p><strong>{proxima.pedido.cliente.nome}</strong> · {lugarDe(proxima.pedido)}</p></> : <p>As próximas visitas aparecem aqui assim que forem marcadas.</p>}
    </section>
    <section className="painel">
      <div className="linha"><h2>Visitas do dia</h2><Campo nome="dia" rotulo="Dia da agenda"><input type="date" value={dia} onChange={e => setDia(e.target.value || dataISO.format())}/></Campo></div>
      {!!dias.length && <div className="acoes">{dias.map(data => <button key={data} className="secundario" aria-pressed={data === dia} onClick={() => setDia(data)}>{dataDe(data)}</button>)}</div>}
      <p className="suave">Horário de Brasília</p>
      {doDia.length ? <ul className="visitas">{doDia.map(v => <li key={v.id}><time dateTime={v.horario}>{horarioDe(v.horario)}</time><div><strong>{v.pedido.cliente.nome}</strong><p>{lugarDe(v.pedido)}</p></div></li>)}</ul> : <p>Nenhuma visita confirmada para este dia.</p>}
    </section>
  </>;
}

type Tela = 'inicio' | 'novo' | 'pedidos' | 'agenda' | 'profissional' | 'acesso-profissional'
  | 'cadastro-profissional' | 'situacao-profissional' | 'verificar-conta' | 'revisao';
const confirmacoes: Record<Acao, string> = {
  informacoes: 'Mensagem enviada. O cliente pode responder em Meus pedidos.',
  respostas: 'Resposta enviada. O engenheiro pode continuar a análise do pedido.',
  conclusao: 'Atendimento concluído.',
  visitas: 'Visita marcada. O cliente já pode consultar o dia e a hora.',
};
function App() {
  const [sessao, setSessao] = useState(lerSessao);
  const [tela, setTela] = useState<Tela>(() => {
    if (sessao?.conta.papel === 'ADMIN') return 'revisao';
    if (sessao?.conta.papel === 'ENGENHEIRO') return acessoProfissionalLegado ? 'agenda' : 'situacao-profissional';
    return 'inicio';
  });
  const [pedidos, setPedidos] = useState<Pedido[]>([]);
  const [visitas, setVisitas] = useState<Visita[]>([]);
  const [filtros, setFiltros] = useState('');
  const [recarga, setRecarga] = useState(0);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');
  const [acessoNegado, setAcessoNegado] = useState(false);
  const [cadastroDireto, setCadastroDireto] = useState(false);
  const [saindo, setSaindo] = useState(false);
  const [perfil, setPerfil] = useState<PerfilProfissional | null>();
  const [revisoes, setRevisoes] = useState<Revisao[]>([]);
  const cliente = sessao?.conta.papel === 'CLIENTE';
  const profissional = sessao?.conta.papel === 'ENGENHEIRO';
  const admin = sessao?.conta.papel === 'ADMIN';
  const engenheiro = profissional && (acessoProfissionalLegado || perfil?.situacao === 'APROVADO');

  function limparSessao(expirada = false) {
    const destino = profissional || admin ? 'acesso-profissional' : tela === 'novo' ? 'novo' : 'pedidos';
    sessionStorage.removeItem('agenda.sessao');
    setSessao(null);
    setPedidos([]);
    setVisitas([]);
    setFiltros('');
    setPerfil(undefined);
    setRevisoes([]);
    ir(expirada ? destino : 'inicio');
    if (expirada) setAviso('Sua sessão terminou. Entre novamente para continuar.');
  }

  async function sair() {
    if (!sessao || saindo) return;
    setSaindo(true);
    try {
      await api('/auth/sair', sessao.token, {}, AbortSignal.timeout(8000));
      limparSessao();
    } catch (falha) {
      if (falha instanceof Falha && falha.status === 401) limparSessao();
      else setAviso('Não foi possível confirmar a saída. Confira a conexão e toque em Sair novamente.');
    } finally {
      setSaindo(false);
    }
  }

  function ir(destino: Tela) {
    setErro('');
    setAviso('');
    setAcessoNegado(false);
    setCadastroDireto(false);
    setTela(destino);
    window.scrollTo(0, 0);
  }

  useEffect(() => {
    if (!sessao) return;
    const restante = Date.parse(sessao.expiraEm) - Date.now();
    const timer = window.setTimeout(() => limparSessao(true), restante > 0 ? restante : 0);
    return () => window.clearTimeout(timer);
  }, [sessao, tela]);

  useEffect(() => {
    if (!sessao || !['pedidos', 'agenda', 'situacao-profissional', 'revisao'].includes(tela)) return;
    let ativa = true;
    setErro('');
    setCarregando(true);
    const buscar = tela === 'revisao'
      ? api<Revisao[]>('/profissionais/revisao', sessao.token).then(lista => { if (ativa) setRevisoes(lista); })
      : tela === 'situacao-profissional'
        ? api<{ perfil: PerfilProfissional | null }>('/profissionais/meu-perfil', sessao.token).then(dados => { if (ativa) setPerfil(dados.perfil); })
        : tela === 'agenda'
          ? api<Visita[]>('/visitas', sessao.token).then(lista => { if (ativa) setVisitas(lista); })
          : api<Pedido[]>('/pedidos' + (filtros ? '?' + filtros : ''), sessao.token).then(lista => { if (ativa) setPedidos(lista); });
    void buscar.catch((e: Falha) => {
      if (!ativa) return;
      if (e.status === 401) {
        limparSessao(true);
      } else setErro(e.message);
    }).finally(() => { if (ativa) setCarregando(false); });
    return () => { ativa = false; };
  }, [sessao, tela, filtros, recarga]);

  function entrar(nova: Sessao) {
    if (nova.conta.papel !== 'CLIENTE' && tela !== 'acesso-profissional' && tela !== 'cadastro-profissional') {
      throw new Falha('Use Área do profissional no rodapé para entrar com esta conta.');
    }
    setPerfil(undefined);
    setRevisoes([]);
    setPedidos([]);
    setVisitas([]);
    setFiltros('');
    sessionStorage.setItem('agenda.sessao', JSON.stringify(nova));
    setSessao(nova);
    if (nova.conta.papel === 'ENGENHEIRO') ir(acessoProfissionalLegado ? 'agenda' : 'situacao-profissional');
    else if (nova.conta.papel === 'ADMIN') ir('revisao');
    else if (tela === 'acesso-profissional') setAcessoNegado(true);
    else window.scrollTo(0, 0);
  }

  async function enviar<T>(rota: string, dados: object) {
    try { return await api<T>(rota, sessao?.token, dados); }
    catch (e) {
      if (e instanceof Falha && e.status === 401) {
        limparSessao(true);
      }
      throw e;
    }
  }

  function cartao(pedido: Pedido) {
    return <CartaoPedido key={pedido.id} pedido={pedido} engenheiro={engenheiro} mudar={async (acao, dados) => {
      const atualizado = await enviar<Pedido>(acao === 'visitas' ? '/visitas' : '/pedidos/' + pedido.id + '/' + acao, dados);
      setPedidos(lista => lista.map(item => item.id === atualizado.id ? atualizado : item));
      setAviso(confirmacoes[acao]);
    }}/>;
  }

  const pendentes = pedidos.filter(pedido => pedido.situacao === 'RECEBIDO');
  const demais = pedidos.filter(pedido => pedido.situacao !== 'RECEBIDO');

  function abrirAreaProfissional() {
    ir(admin ? 'revisao' : profissional ? acessoProfissionalLegado ? 'agenda' : 'situacao-profissional' : 'profissional');
  }

  return <>
    <header className="topo"><div className="limite barra">
      <button className="marca" onClick={() => ir('inicio')}><span aria-hidden="true">⌖</span> <strong>Agenda do<br className="marca-quebra"/> Engenheiro Civil</strong></button>
      <nav aria-label="Navegação principal">
        {!sessao && <>
          <button onClick={() => ir(tela === 'novo' ? 'novo' : 'pedidos')}>Entrar</button>
          <button className="atalho-cadastro" onClick={() => { ir(tela === 'novo' ? 'novo' : 'pedidos'); setCadastroDireto(true); }}>Criar conta</button>
        </>}
        {cliente && <button aria-current={tela === 'pedidos' ? 'page' : undefined} onClick={() => ir('pedidos')}>Meus pedidos</button>}
        {engenheiro && <><button aria-current={tela === 'pedidos' ? 'page' : undefined} onClick={() => ir('pedidos')}>Pedidos</button><button aria-current={tela === 'agenda' ? 'page' : undefined} onClick={() => ir('agenda')}>Agenda</button></>}
        {sessao && <button className="sair" disabled={saindo} onClick={sair}>{saindo ? 'Saindo…' : 'Sair'}</button>}
      </nav>
    </div></header>
    <main className="limite" id="area-profissional">
      {aviso && <p className="aviso" role="status">{aviso}</p>}
      {tela === 'inicio' && <Capa pedir={() => !sessao || cliente ? ir('novo') : abrirAreaProfissional()} acompanhar={() => !sessao || cliente ? ir('pedidos') : abrirAreaProfissional()}/>}
      {tela === 'profissional' && <section className="painel estreito">
        <h1>Área do profissional</h1><p>{acessoProfissionalLegado ? 'Entre com sua conta profissional para acessar o painel.' : 'Entre para acompanhar sua verificação ou solicite um cadastro.'}</p>
        <div className="acoes"><button className="primario" onClick={() => ir('acesso-profissional')}>Entrar como profissional</button>{!acessoProfissionalLegado && <button className="secundario" onClick={() => ir('cadastro-profissional')}>Solicitar cadastro profissional</button>}</div>
      </section>}
      {tela === 'acesso-profissional' && <Acesso key={tela} profissional entrar={entrar} negado={acessoNegado} irParaPedidos={() => ir('pedidos')}/>}
      {(tela === 'cadastro-profissional' || (tela === 'verificar-conta' && profissional)) && <FormularioProfissional
        key={tela} autenticado={tela === 'verificar-conta'} enviar={async dados => {
          const registro = { titulo: dados.titulo, creaUf: dados.creaUf, registro: dados.registro, autorizaPublicacao: dados.autorizaPublicacao === 'on' };
          if (tela === 'verificar-conta') {
            await enviar('/profissionais/meu-perfil', { ...registro, nomeCompleto: dados.nome });
            ir('situacao-profissional');
          } else entrar(await api<Sessao>('/auth/cadastro-profissional', undefined, { nome: dados.nome, celular: dados.celular, senha: dados.senha, registro }));
        }}/>}
      {tela === 'situacao-profissional' && profissional && <section className="painel estreito">
        <h1>Situação profissional</h1>
        {erro && <p className="retorno erro" role="alert">{erro}</p>}
        {carregando && <p role="status">Consultando a solicitação…</p>}
        {!carregando && perfil === null && <>
          <p>Envie os dados do registro para verificar sua conta atual.</p>
          <button className="primario" onClick={() => ir('verificar-conta')}>Verificar minha conta profissional</button>
        </>}
        {!carregando && perfil && <>
          <h2>{situacoesProfissionais[perfil.situacao]}</h2>
          <p>{perfil.nomeCompleto} · {perfil.titulo} · CREA-{perfil.creaUf} {perfil.registro}</p>
          {perfil.situacao === 'EM_ANALISE' && <p>A administração vai conferir seu registro e confirmar a titularidade antes de liberar o painel.</p>}
          {perfil.situacao === 'REJEITADO' && <p>Fale com a administração para esclarecer a decisão.</p>}
          {perfil.situacao === 'APROVADO' && <p>Você já pode acessar Pedidos e Agenda.</p>}
          {perfil.situacao !== 'REJEITADO' && <Formulario key={String(perfil.autorizaPublicacao)} titulo="Salvar preferência" enviar={async dados => {
            setPerfil(await enviar<PerfilProfissional>('/profissionais/meu-perfil/publicacao', { autorizaPublicacao: dados.autorizaPublicacao === 'on' }));
            setAviso('Preferência de publicação salva.');
          }}>{() => <label className="confirmacao"><input name="autorizaPublicacao" type="checkbox" defaultChecked={perfil.autorizaPublicacao}/> Autorizo publicar meu nome, título e registro após aprovação.</label>}</Formulario>}
        </>}
        <button className="texto" disabled={carregando} onClick={() => setRecarga(n => n + 1)}>Atualizar situação</button>
      </section>}
      {tela === 'revisao' && admin && <>
        <h1>Revisão profissional</h1>
        {erro && <p className="retorno erro" role="alert">{erro}</p>}
        <button className="secundario" disabled={carregando} onClick={() => setRecarga(n => n + 1)}>Atualizar solicitações</button>
        {carregando ? <p role="status">Carregando solicitações…</p> : <PainelRevisao revisoes={revisoes} revisar={async (id, dados) => {
          await enviar('/profissionais/revisao/' + id, dados);
          setAviso('Decisão registrada.');
          setRecarga(n => n + 1);
        }}/>}
      </>}
      {!sessao && (tela === 'novo' || tela === 'pedidos') && <Acesso key={tela} entrar={entrar} destino={tela} cadastro={cadastroDireto} alternarCadastro={setCadastroDireto}/>}
      {cliente && tela === 'novo' && <NovoPedido enviar={async dados => {
        await enviar('/pedidos', dados);
        ir('pedidos');
        setAviso('Pedido enviado. O engenheiro vai informar o dia e a hora por aqui.');
      }}/>}
      {((tela === 'pedidos' && (cliente || engenheiro)) || (tela === 'agenda' && engenheiro)) && <>
        <div className="linha cabecalho"><h1>{tela === 'agenda' ? 'Agenda' : engenheiro ? 'Pedidos' : 'Meus pedidos'}</h1>
          <div className="acoes">{cliente && <button className="primario" onClick={() => ir('novo')}>Pedir atendimento</button>}
          <button className="secundario" disabled={carregando} onClick={() => {
            setAviso('');
            setRecarga(n => n + 1);
          }}>Atualizar</button></div>
        </div>
        {engenheiro && tela === 'pedidos' && <form className="painel filtros" onSubmit={evento => {
          evento.preventDefault();
          const dados = new FormData(evento.currentTarget);
          const busca = new URLSearchParams();
          for (const [chave, valor] of dados) if (String(valor).trim()) busca.set(chave, String(valor).trim());
          if (busca.toString() === filtros) setRecarga(n => n + 1);
          else setFiltros(busca.toString());
        }} onReset={() => setFiltros('')}>
          <Campo nome="municipio" rotulo="Município"><input name="municipio" maxLength={90}/></Campo>
          <Campo nome="comunidade" rotulo="Comunidade"><input name="comunidade" maxLength={100}/></Campo>
          <div className="acoes"><button className="secundario" type="submit">Filtrar</button><button className="texto" type="reset">Limpar</button></div>
        </form>}
        {erro && <p className="retorno erro" role="alert">{erro} Use Atualizar para tentar novamente.</p>}
        {carregando && <p className="retorno" role="status">{tela === 'agenda' ? 'Carregando a agenda…' : 'Carregando os pedidos…'}</p>}
        {tela === 'agenda' && !carregando && !erro && <Agenda visitas={visitas}/>}
        {tela === 'pedidos' && !carregando && !erro && !pedidos.length && <div className="painel vazio">
          <h2>{engenheiro && filtros ? 'Nenhum resultado' : 'Ainda não há pedidos'}</h2>
          <p>{engenheiro ? filtros ? 'Altere os filtros ou escolha Limpar para ver todos os pedidos.' : 'As solicitações dos clientes aparecem aqui.' : 'Escolha Pedir atendimento para enviar sua primeira solicitação.'}</p>
        </div>}
        {tela === 'pedidos' && !!pedidos.length && (engenheiro ? <>
          {!!pendentes.length && <section className="fila atencao"><h2>Precisam de atenção <span>{pendentes.length}</span></h2>{pendentes.map(cartao)}</section>}
          {!!demais.length && <section className="fila"><h2>Demais pedidos</h2>{demais.map(cartao)}</section>}
        </> : pedidos.map(cartao))}
      </>}
    </main>
    <footer className="limite rodape">
      <span>Agenda do Engenheiro Civil</span>
      <a href="#area-profissional" onClick={evento => { evento.preventDefault(); abrirAreaProfissional(); }}>Área do profissional</a>
    </footer>
  </>;
}

createRoot(document.getElementById('root')!).render(<App/>);
