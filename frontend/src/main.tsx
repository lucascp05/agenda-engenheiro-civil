import { cloneElement, useEffect, useId, useState, type FormEvent, type ReactElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type Conta = { nome: string; celular: string | null; email?: string | null; profissional?: boolean; trocarSenha?: boolean; papel: 'CLIENTE' | 'ENGENHEIRO' | 'ADMIN' };
type Sessao = { conta: Conta; token: string; expiraEm: string };
type Situacao = 'RECEBIDO' | 'INFORMACOES' | 'MARCADO' | 'CONCLUIDO';
type Lugar = { municipio: string; comunidade?: string; local: string };
type Pedido = Lugar & {
  id: string; servico: string; celular?: string; descricao: string; link?: string; situacao: Situacao;
  cliente: Conta; visita?: { horario: string };
  mensagens: { id: string; texto: string; autor: Conta['papel'] }[];
};
type Visita = { id: string; horario: string; pedido: Lugar & { servico: string; cliente: { nome: string } } };
type FalhaDados = { message?: string; campos?: Record<string, string> };
const apiUrl = (import.meta.env.VITE_API_URL || 'http://localhost:3000').replace(/\/$/, '');
const rotulos: Record<Situacao, string> = {
  RECEBIDO: 'Pedido recebido', INFORMACOES: 'Precisamos de informações',
  MARCADO: 'Visita marcada', CONCLUIDO: 'Concluído',
};
const servicos = ['Topografia', 'CAR', 'Serviços relacionados ao INCRA', 'Projetos', 'Não sei qual serviço preciso'];
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

const avisoEmail = 'Cadastro e recuperação por e-mail estão indisponíveis nesta versão. Entre com uma conta existente.';

function Acesso({ entrar, voltar, profissional, destino, cadastro = false, alternarCadastro, emailDisponivel, conviteProfissionalDisponivel }: {
  entrar: (sessao: Sessao) => Promise<void> | void;
  voltar?: () => void;
  profissional?: boolean;
  destino?: 'novo' | 'pedidos';
  cadastro?: boolean;
  alternarCadastro?: (cadastro: boolean) => void;
  emailDisponivel?: boolean;
  conviteProfissionalDisponivel?: boolean;
}) {
  const [legado, setLegado] = useState(false);
  const [recuperar, setRecuperar] = useState(false);
  const [convite, setConvite] = useState(false);
  const [retorno, setRetorno] = useState('');
  const [cadastroEnviado, setCadastroEnviado] = useState(false);
  const login = !cadastro && !recuperar && !convite;
  const celular = legado && login;
  const emailBloqueado = (cadastro || recuperar) && emailDisponivel === false;
  const titulo = convite ? 'Ativar acesso profissional' : cadastro ? 'Crie sua conta' : recuperar ? 'Redefinir senha' : profissional ? 'Entrar como profissional' : 'Acesso do cliente';
  async function enviar(dados: Record<string, string>) {
    if (login) return entrar(await api<Sessao>('/auth/login', undefined, dados));
    const rota = convite ? '/auth/convite-profissional' : cadastro ? '/auth/cadastro' : '/auth/recuperacao';
    const { mensagem } = await api<{ mensagem: string }>(rota, undefined, dados);
    setRetorno(mensagem);
    if (cadastro) setCadastroEnviado(true);
  }
  function alternar(novoCadastro: boolean) {
    setRecuperar(false);
    setLegado(false);
    setRetorno('');
    setCadastroEnviado(false);
    alternarCadastro?.(novoCadastro);
  }
  return <section className="painel estreito acesso painel-formulario">
    {voltar && <button type="button" className="texto voltar-acesso" onClick={voltar}>
      <span aria-hidden="true">←</span> Voltar
    </button>}
    <h1>{titulo}</h1>
    {cadastro && !emailBloqueado && <p>Informe seu nome e e-mail. Você vai criar a senha ao abrir o link de confirmação.</p>}
    {!cadastro && !recuperar && destino === 'novo' && <p>{emailDisponivel === false ? 'Entre para continuar com seu pedido.' : 'Entre ou crie uma conta para continuar com seu pedido.'}</p>}
    {emailBloqueado ? <p className="retorno" role="status">{avisoEmail}</p> : <Formulario key={titulo + celular} titulo={cadastro ? cadastroEnviado ? 'Reenviar confirmação' : 'Enviar confirmação' : login ? 'Entrar' : 'Enviar link'} enviar={enviar}>
      {erro => <>
        {cadastro && <Campo nome="nome" rotulo="Nome" erro={erro}><input name="nome" autoComplete="name" required minLength={2} maxLength={80}/></Campo>}
        {celular
          ? <Campo nome="celular" rotulo="Celular com DDD" erro={erro}><input name="celular" type="tel" autoComplete="username" required maxLength={20}/></Campo>
          : <Campo nome="email" rotulo="E-mail" erro={erro}><input name="email" type="email" autoComplete={login ? 'username' : 'email'} required maxLength={254}/></Campo>}
        {login && <Campo nome="senha" rotulo="Senha" erro={erro}><input name="senha" type="password" autoComplete="current-password" required minLength={8} maxLength={128}/></Campo>}
      </>}
    </Formulario>}
    {retorno && <p className="retorno" role="status">{retorno}</p>}
    {!profissional && alternarCadastro && <button className="texto alternar-acesso" onClick={() => alternar(!cadastro && !recuperar)}>{cadastro || recuperar ? 'Voltar para Entrar' : 'Criar conta'}</button>}
    {login && <button className="texto alternar-acesso" onClick={() => { setLegado(!legado); setRetorno(''); }}>{celular ? 'Entrar com e-mail' : 'Já tenho conta por celular'}</button>}
    {!cadastro && !convite && <button className="texto alternar-acesso" onClick={() => { setRecuperar(!recuperar); setRetorno(''); }}>{recuperar ? 'Voltar ao login' : 'Esqueci minha senha'}</button>}
    {profissional && conviteProfissionalDisponivel && !recuperar && <button className="texto alternar-acesso" onClick={() => { setConvite(!convite); setRetorno(''); }}>{convite ? 'Voltar ao login' : 'Ativar acesso profissional'}</button>}
  </section>;
}

type PerfilProfissional = { nomeCompleto: string; titulo: string; creaUf: string; registro: string; autorizaPublicacao: boolean };
const consultaOficial = 'https://consultaprofissional.confea.org.br/';
const ufs = 'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PE PI PR RJ RN RO RR RS SC SE SP TO'.split(' ');

function Capa({ pedir, acompanhar }: { pedir: () => void; acompanhar: () => void }) {
  const [perfil, setPerfil] = useState<PerfilProfissional | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ perfil: PerfilProfissional | null }>('/profissionais/publico', undefined, undefined, controller.signal)
      .then(({ perfil }) => setPerfil(perfil)).catch(() => {});
    return () => controller.abort();
  }, []);
  return <>
    <section className="hero">
      <div className="hero-conteudo">
        <h1>Topografia e engenharia civil</h1>
        <p>Solicite atendimento para seu imóvel e acompanhe a confirmação da visita por aqui.</p>
        <div className="acoes"><button className="primario" onClick={pedir}>Pedir atendimento</button><button className="secundario" onClick={acompanhar}>Acompanhar meu pedido</button></div>
      </div>
      <picture className="hero-foto">
        <source media="(max-width: 767px)" srcSet="/topografia-rural-mobile.webp"/>
        <img src="/topografia-rural.webp" alt="Estação total em um tripé de topografia em área rural" width="1200" height="800" fetchPriority="high"/>
      </picture>
    </section>
    <section className="secao-capa">
      <h2>Serviços</h2>
      <div className="servicos">{servicosCapa.map(([nome, descricao]) => <article key={nome} className={nome === 'Topografia' ? 'servico-principal' : undefined}><h3>{nome}</h3><p>{descricao}</p></article>)}</div>
    </section>
    <section className="secao-capa painel quem-atende">
      <h2>Quem atende</h2>
      <div className="identidade-profissional">
        <div>
          <h3>Tatico Assis</h3>
          {perfil && <>
            <p className="titulo-profissional">{perfil.nomeCompleto} · {perfil.titulo}</p>
            <p className="registro-profissional">CREA-{perfil.creaUf} <strong>{perfil.registro}</strong></p>
          </>}
        </div>
        {perfil && <div className="consulta-profissional">
          <a className="secundario" href={consultaOficial} target="_blank" rel="noreferrer">Consultar registro no Confea</a>
        </div>}
      </div>
    </section>
    <section className="secao-capa">
      <h2>Como funciona</h2>
      <ol className="fluxo">{etapas.map(([titulo, descricao]) => <li key={titulo}><h3>{titulo}</h3><p>{descricao}</p></li>)}</ol>
    </section>
    <section className="secao-capa painel quem-atende">
      <h2>Contato</h2>
      <a className="secundario" href="https://wa.me/5583981421864" target="_blank" rel="noreferrer">Falar pelo WhatsApp</a>
    </section>
  </>;
}

function FormularioProfissional({ perfil, enviar }: { perfil?: PerfilProfissional | null; enviar: (dados: Record<string, string>) => Promise<void> }) {
  return <section className="painel estreito painel-formulario">
    <h1>Quem atende</h1>
    <Formulario titulo="Salvar perfil" enviar={enviar}>{erro => <>
      <Campo nome="nomeCompleto" rotulo="Nome completo" erro={erro}><input name="nomeCompleto" defaultValue={perfil?.nomeCompleto} minLength={3} maxLength={80} required/></Campo>
      <Campo nome="titulo" rotulo="Título profissional conforme o registro" erro={erro}><input name="titulo" defaultValue={perfil?.titulo} minLength={2} maxLength={120} required/></Campo>
      <Campo nome="creaUf" rotulo="CREA-UF" erro={erro}><select name="creaUf" required defaultValue={perfil?.creaUf ?? ''}><option value="" disabled>Selecione a UF</option>{ufs.map(uf => <option key={uf}>{uf}</option>)}</select></Campo>
      <Campo nome="registro" rotulo="Número de registro" erro={erro}><input name="registro" defaultValue={perfil?.registro} maxLength={40} required/></Campo>
      <label className="confirmacao"><input name="autorizaPublicacao" type="checkbox" defaultChecked={perfil?.autorizaPublicacao}/> Confirmo os dados e autorizo publicar meu nome, título e registro na capa.</label>
    </>}</Formulario>
  </section>;
}

function NovoPedido({ enviar }: { enviar: (dados: object) => Promise<void> }) {
  return <section className="painel estreito painel-formulario">
    <h1>Pedir atendimento</h1>
    <p>Informe o serviço e o local. O engenheiro vai definir o dia e o horário.</p>
    <Formulario titulo="Enviar pedido" enviar={enviar}>{erro => <>
      <Campo nome="servico" rotulo="Tipo de serviço" erro={erro}><select name="servico" required defaultValue=""><option value="" disabled>Selecione um serviço</option>{servicos.map(s => <option key={s}>{s}</option>)}</select></Campo>
      <Campo nome="municipio" rotulo="Em qual município fica o imóvel?" erro={erro}><input name="municipio" required minLength={2} maxLength={90}/></Campo>
      <Campo nome="comunidade" rotulo="Comunidade ou localidade (opcional)" erro={erro}><input name="comunidade" minLength={2} maxLength={100}/></Campo>
      <Campo nome="local" rotulo="Como chegar?" erro={erro}><input name="local" required minLength={3} maxLength={160} placeholder="Estrada, endereço ou ponto de referência"/></Campo>
      <Campo nome="descricao" rotulo="O que você precisa?" erro={erro}><textarea name="descricao" required minLength={3} maxLength={400} rows={3}/></Campo>
      <Campo nome="celular" rotulo="Celular com DDD para combinar a visita (opcional)" erro={erro}><input name="celular" type="tel" autoComplete="tel-national" maxLength={20}/></Campo>
      <Campo nome="link" rotulo="Link de localização (opcional)" erro={erro}><input type="url" name="link" maxLength={500} placeholder="https://"/></Campo>
    </>}</Formulario>
  </section>;
}

type Acao = 'informacoes' | 'respostas' | 'conclusao' | 'visitas';
function CartaoPedido({ pedido, engenheiro, mudar }: { pedido: Pedido; engenheiro: boolean; mudar: (acao: Acao, dados: object) => Promise<void> }) {
  const [acao, setAcao] = useState<Acao>();
  const celular = pedido.celular || pedido.cliente.celular;
  const ultimaMensagem = pedido.mensagens.at(-1);
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
    {!engenheiro && pedido.situacao === 'INFORMACOES' && <p className="orientacao">Responda à última mensagem para o engenheiro continuar o atendimento.</p>}
    {!engenheiro && pedido.situacao === 'MARCADO' && <p className="orientacao">Prepare o acesso ao imóvel para o dia e horário confirmados.</p>}
    {engenheiro && pedido.situacao === 'RECEBIDO' && <p className="orientacao">{ultimaMensagem?.autor === 'CLIENTE' ? 'O cliente respondeu' : 'Novo pedido'}</p>}
    {engenheiro && <p><strong>{pedido.cliente.nome}</strong>
      {celular && <> · <a href={'tel:+55' + celular}>{celular.replace(/^(\d{2})(\d{5})(\d{4})$/, '($1) $2-$3')}</a></>}
      {pedido.cliente.email && <> · <a href={'mailto:' + pedido.cliente.email}>{pedido.cliente.email}</a></>}
    </p>}
    <p>{lugarDe(pedido)}</p>
    <p>{pedido.descricao}</p>
    {pedido.link && <p><a href={pedido.link} target="_blank" rel="noreferrer">Abrir no mapa</a></p>}
    {!!pedido.mensagens.length && <ul className="conversa" aria-label="Mensagens do pedido">{pedido.mensagens.map(m => <li key={m.id}><strong>{m.autor === 'ENGENHEIRO' ? 'Engenheiro' : 'Cliente'}</strong><p>{m.texto}</p>{!engenheiro && pedido.situacao === 'INFORMACOES' && m.id === ultimaMensagem?.id && acao !== 'respostas' && <button className="primario" onClick={() => setAcao('respostas')}>Responder</button>}</li>)}</ul>}
    {!engenheiro && pedido.situacao === 'INFORMACOES' && acao === 'respostas' && <div className="editor">
      <Formulario titulo="Enviar resposta" enviar={dados => enviar('respostas', dados)}>{erro =>
        <Campo nome="texto" rotulo="Sua resposta" erro={erro}><textarea name="texto" rows={2} required minLength={3} maxLength={400} autoFocus/></Campo>
      }</Formulario>
      <button className="texto" onClick={() => setAcao(undefined)}>Cancelar</button>
    </div>}
    {engenheiro && pedido.situacao !== 'CONCLUIDO' && <div className="acoes">
      {aberto && <><button className="primario" onClick={() => setAcao('visitas')}>Marcar visita</button><button className="secundario" onClick={() => setAcao('informacoes')}>Pedir informações</button></>}
      {pedido.situacao === 'MARCADO' && <button className="primario" onClick={() => setAcao('visitas')}>Remarcar visita</button>}
      <button className="secundario" onClick={() => setAcao('conclusao')}>Concluir atendimento</button>
    </div>}
    {engenheiro && acao && <div className="editor">
      {acao === 'visitas' && <Formulario titulo={pedido.visita ? 'Confirmar remarcação' : 'Confirmar visita'} enviar={dados => enviar('visitas', { pedidoId: pedido.id, horarioAnterior: pedido.visita?.horario, ...dados })}>{erro =>
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
  const agora = Date.now();
  const proximas = visitas.filter(v => Date.parse(v.horario) >= agora);
  const [dia, setDia] = useState(dataISO.format());
  const doDia = visitas.filter(v => diaDe(v.horario) === dia);
  return <>
    <section className="destaque">
      <h2>Próximas visitas</h2>
      <p className="suave">Horário de Brasília</p>
      {proximas.length ? <ul className="visitas">{proximas.map(v => <li key={v.id}>
        <time dateTime={v.horario}>{dataDe(diaDe(v.horario))} às {horarioDe(v.horario)}</time>
        <div><strong>{v.pedido.cliente.nome}</strong><p>{v.pedido.servico} · {lugarDe(v.pedido)}</p></div>
      </li>)}</ul> : <p>As próximas visitas aparecem aqui assim que forem marcadas.</p>}
    </section>
    <section className="painel">
      <div className="linha"><h2>Visitas do dia</h2><Campo nome="dia" rotulo="Dia da agenda"><input type="date" value={dia} onChange={e => setDia(e.target.value || dataISO.format())}/></Campo></div>
      <p className="suave">Horário de Brasília</p>
      {doDia.length ? <ul className="visitas">{doDia.map(v => <li key={v.id}><time dateTime={v.horario}>{horarioDe(v.horario)}</time><div><strong>{v.pedido.cliente.nome}</strong><p>{v.pedido.servico} · {lugarDe(v.pedido)}</p></div></li>)}</ul> : <p>Nenhuma visita confirmada para este dia.</p>}
    </section>
  </>;
}

type Tela = 'inicio' | 'novo' | 'pedidos' | 'agenda' | 'acesso-profissional' | 'perfil' | 'conta' | 'email';
type LinkEmail = { acao: 'CADASTRO' | 'VINCULO' | 'RECUPERACAO' | 'PROPRIETARIO'; token: string };

function lerLinkEmail(): LinkEmail | null {
  const dados = new URLSearchParams(location.hash.slice(1));
  const acao = dados.get('acao');
  const token = dados.get('token');
  if ((acao === 'CADASTRO' || acao === 'VINCULO' || acao === 'RECUPERACAO' || acao === 'PROPRIETARIO') && token) return { acao, token };
  return null;
}

const confirmacoes: Record<Acao, string> = {
  informacoes: 'Mensagem enviada. O cliente pode responder em Meus pedidos.',
  respostas: 'Resposta enviada. O engenheiro pode continuar a análise do pedido.',
  conclusao: 'Atendimento concluído.',
  visitas: 'Visita marcada. O cliente já pode consultar o dia e a hora.',
};
function App() {
  const [sessao, setSessao] = useState(lerSessao);
  const [emailDisponivel, setEmailDisponivel] = useState<boolean>();
  const [conviteProfissionalDisponivel, setConviteProfissionalDisponivel] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ emailDisponivel: boolean; conviteProfissionalDisponivel?: boolean }>('/auth/recursos', undefined, undefined, controller.signal)
      .then(recursos => {
        setEmailDisponivel(recursos.emailDisponivel);
        setConviteProfissionalDisponivel(recursos.conviteProfissionalDisponivel === true);
      }).catch(() => {});
    return () => controller.abort();
  }, []);
  const [link, setLink] = useState(lerLinkEmail);
  const [navegacao, setNavegacao] = useState<{ tela: Tela; cadastro: boolean }>(() =>
    link ? { tela: 'email', cadastro: false } : history.state?.agenda ??
      { tela: sessao?.conta.profissional ? 'pedidos' : 'inicio', cadastro: false });
  const engenheiro = sessao?.conta.profissional === true;
  const trocaObrigatoria = engenheiro && sessao?.conta.trocarSenha;
  const pagina = navegacao.tela;
  const tela = trocaObrigatoria ? 'conta' : pagina === 'acesso-profissional' && engenheiro ? 'pedidos'
    : (pagina === 'perfil' || pagina === 'agenda') && !engenheiro ? 'acesso-profissional'
      : pagina === 'conta' && !sessao ? 'pedidos' : pagina === 'email' && !link ? 'inicio' : pagina;
  useEffect(() => {
    function abrirLink() {
      const novo = lerLinkEmail();
      if (!novo) return;
      const agenda = { tela: 'email' as const, cadastro: false };
      history.replaceState({ agenda }, '', location.pathname + location.search);
      setLink(novo);
      setNavegacao(agenda);
    }
    history.replaceState({ agenda: navegacao }, '');
    abrirLink();
    window.addEventListener('hashchange', abrirLink);
    function voltarOuAvancar() {
      setNavegacao(history.state?.agenda ?? { tela: 'inicio', cadastro: false });
      setErro('');
      setAviso('');
    }
    window.addEventListener('popstate', voltarOuAvancar);
    return () => {
      window.removeEventListener('hashchange', abrirLink);
      window.removeEventListener('popstate', voltarOuAvancar);
    };
  }, []);
  const [pedidos, setPedidos] = useState<Pedido[]>([]);
  const [visitas, setVisitas] = useState<Visita[]>([]);
  const [filtros, setFiltros] = useState('');
  const [recarga, setRecarga] = useState(0);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');
  const [saindo, setSaindo] = useState(false);
  const [perfil, setPerfil] = useState<PerfilProfissional | null>();
  const cliente = sessao?.conta.papel === 'CLIENTE';

  function limparSessao(expirada = false) {
    const destino = tela === 'email' && link?.acao === 'VINCULO' ? 'email'
      : engenheiro ? 'acesso-profissional' : tela === 'novo' ? 'novo' : 'pedidos';
    sessionStorage.removeItem('agenda.sessao');
    setSessao(null);
    setPedidos([]);
    setVisitas([]);
    setFiltros('');
    setPerfil(undefined);
    ir(expirada ? destino : 'inicio', false, true);
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

  function ir(destino: Tela, cadastro = false, substituir = false) {
    setErro('');
    setAviso('');
    const agenda = { tela: destino, cadastro };
    if (substituir) history.replaceState({ agenda }, '');
    else if (history.state?.agenda?.tela !== destino || history.state?.agenda?.cadastro !== cadastro) {
      history.pushState({ agenda }, '');
    }
    setNavegacao(agenda);
    window.scrollTo(0, 0);
  }

  useEffect(() => {
    if (!sessao) return;
    const restante = Date.parse(sessao.expiraEm) - Date.now();
    const timer = window.setTimeout(() => limparSessao(true), restante > 0 ? restante : 0);
    return () => window.clearTimeout(timer);
  }, [sessao, tela]);

  useEffect(() => {
    if (!sessao || !['pedidos', 'agenda', 'perfil'].includes(tela)) return;
    let ativa = true;
    setErro('');
    setCarregando(true);
    const buscar = tela === 'perfil'
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

  function salvarSessao(nova: Sessao) {
    sessionStorage.setItem('agenda.sessao', JSON.stringify(nova));
    setSessao(nova);
  }

  async function entrar(nova: Sessao) {
    const loginProfissional = tela === 'acesso-profissional';
    const vinculo = tela === 'email' && link?.acao === 'VINCULO';
    if ((!vinculo && loginProfissional && !nova.conta.profissional) ||
        (!vinculo && !loginProfissional && nova.conta.papel !== 'CLIENTE') ||
        (vinculo && nova.conta.papel !== 'CLIENTE' && !nova.conta.profissional)) {
      await api('/auth/sair', nova.token, {}).catch(() => {});
      throw new Falha(loginProfissional || vinculo ? 'Esta conta não tem acesso a esta área.' : 'Use a Área do profissional no rodapé.');
    }
    setPerfil(undefined);
    setPedidos([]);
    setVisitas([]);
    setFiltros('');
    salvarSessao(nova);
    if (!vinculo) ir(nova.conta.trocarSenha ? 'conta' : nova.conta.profissional || tela !== 'novo' ? 'pedidos' : 'novo');
  }

  async function confirmarLink(dados: Record<string, string>) {
    if (!link) return;
    if (link.acao === 'CADASTRO') {
      const nova = await api<Sessao>('/auth/confirmar-email', undefined, { ...dados, token: link.token });
      await Promise.all([nova, ...(sessao ? [sessao] : [])].map(acesso =>
        api('/auth/sair', acesso.token, {}, AbortSignal.timeout(8000)).catch(() => {})));
      limparSessao();
      ir('novo', false, true);
      setAviso('E-mail confirmado. Entre com seu e-mail e a senha que acabou de criar.');
    } else if (link.acao === 'RECUPERACAO' || link.acao === 'PROPRIETARIO') {
      const ativacao = link.acao === 'PROPRIETARIO';
      await api(ativacao ? '/auth/ativar-profissional' : '/auth/redefinir-senha', undefined, { ...dados, token: link.token });
      if (sessao) await api('/auth/sair', sessao.token, {}).catch(() => {});
      limparSessao();
      ir(ativacao ? 'acesso-profissional' : 'pedidos');
      setAviso('Senha salva. Entre com seu e-mail e a nova senha.');
    } else if (sessao) {
      const { conta } = await enviar<{ conta: Conta }>('/auth/confirmar-vinculo', { token: link.token });
      salvarSessao({ ...sessao, conta: { ...sessao.conta, ...conta } });
      ir('pedidos');
      setAviso('E-mail verificado e vinculado à sua conta.');
    }
    setLink(null);
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
      const atualizado = await enviar<Pedido>(acao === 'visitas' ? pedido.visita ? '/visitas/remarcacao' : '/visitas' : '/pedidos/' + pedido.id + '/' + acao, dados);
      setPedidos(lista => lista.map(item => item.id === atualizado.id ? atualizado : item));
      setAviso(acao === 'visitas' && pedido.visita ? 'Visita remarcada. O cliente já pode consultar o novo horário.' : confirmacoes[acao]);
    }}/>;
  }

  const pendentes = pedidos.filter(pedido => pedido.situacao === 'RECEBIDO');
  const demais = pedidos.filter(pedido => pedido.situacao !== 'RECEBIDO');

  function abrirAreaProfissional() {
    ir(engenheiro ? 'pedidos' : 'acesso-profissional');
  }

  return <>
    <header className="topo"><div className="limite barra">
      <button className="marca" onClick={() => ir('inicio')}>
        <img src="/tatico-assis-simbolo.png" alt="" width="40" height="46"/>
        <strong>Tatico Assis</strong>
        <span>Eng. Civil Especialista</span>
      </button>
      <nav aria-label="Navegação principal">
        {!sessao && <>
          <button onClick={() => ir(tela === 'novo' ? 'novo' : 'pedidos')}>Entrar</button>
          <button className="atalho-cadastro" onClick={() => ir(tela === 'novo' ? 'novo' : 'pedidos', true)}>Criar conta</button>
        </>}
        {cliente && <button aria-current={tela === 'pedidos' ? 'page' : undefined} onClick={() => ir('pedidos')}>Meus pedidos</button>}
        {engenheiro && <><button aria-current={tela === 'pedidos' ? 'page' : undefined} onClick={() => ir('pedidos')}>Pedidos</button><button aria-current={tela === 'agenda' ? 'page' : undefined} onClick={() => ir('agenda')}>Agenda</button></>}
        {(cliente || engenheiro) && <button onClick={() => ir('conta')}>Minha conta</button>}
        {sessao && <button className="sair" disabled={saindo} onClick={sair}>{saindo ? 'Saindo…' : 'Sair'}</button>}
      </nav>
    </div></header>
    <main className="limite" id="area-profissional">
      {aviso && <p className="aviso" role="status">{aviso}</p>}
      {tela === 'inicio' && <Capa pedir={() => !sessao || cliente ? ir('novo') : abrirAreaProfissional()} acompanhar={() => !sessao || cliente ? ir('pedidos') : abrirAreaProfissional()}/>}
      {tela === 'acesso-profissional' && <Acesso key={tela} profissional entrar={entrar} voltar={() => ir('inicio')} emailDisponivel={emailDisponivel} conviteProfissionalDisponivel={conviteProfissionalDisponivel}/>}
      {trocaObrigatoria && <section className="painel estreito painel-formulario">
        <h1>Trocar senha</h1>
        <p>Defina sua senha para acessar a agenda.</p>
        <Formulario titulo="Salvar nova senha" enviar={async dados => {
          if (dados.senha !== dados.confirmacao) throw new Falha('As senhas precisam ser iguais.', { confirmacao: 'Repita a nova senha.' });
          await enviar('/auth/trocar-senha', { senhaAtual: dados.senhaAtual, senha: dados.senha });
          limparSessao();
          ir('acesso-profissional', false, true);
          setAviso('Senha alterada. Entre com seu e-mail e a nova senha.');
        }}>{erro => <>
          <Campo nome="senhaAtual" rotulo="Senha atual" erro={erro}><input name="senhaAtual" type="password" autoComplete="current-password" required maxLength={128}/></Campo>
          <Campo nome="senha" rotulo="Nova senha (15 a 128 caracteres)" erro={erro}><input name="senha" type="password" autoComplete="new-password" required minLength={15} maxLength={128}/></Campo>
          <Campo nome="confirmacao" rotulo="Confirme a nova senha" erro={erro}><input name="confirmacao" type="password" autoComplete="new-password" required minLength={15} maxLength={128}/></Campo>
        </>}</Formulario>
      </section>}
      {tela === 'conta' && sessao && !trocaObrigatoria && <section className="painel estreito painel-formulario">
        <h1>Minha conta</h1>
        {sessao.conta.email ? <p>E-mail verificado: {sessao.conta.email}</p> :
          emailDisponivel === false ? <p>Vínculo por e-mail indisponível nesta versão.</p> :
          <Formulario titulo="Enviar confirmação" enviar={async dados => {
            const { mensagem } = await enviar<{ mensagem: string }>('/auth/vincular-email', dados);
            setAviso(mensagem);
          }}>{erro => <Campo nome="email" rotulo="Vincular e-mail" erro={erro}><input name="email" type="email" autoComplete="email" required maxLength={254}/></Campo>}</Formulario>}
        {engenheiro && <button className="texto" onClick={() => ir('perfil')}>Editar perfil da capa</button>}
      </section>}
      {tela === 'perfil' && engenheiro && <>
        {erro && <p className="retorno erro" role="alert">{erro}</p>}
        {carregando && <p role="status">Carregando perfil…</p>}
        {perfil !== undefined && !carregando && !erro && <FormularioProfissional perfil={perfil} enviar={async dados => {
          setPerfil(await enviar<PerfilProfissional>('/profissionais/meu-perfil', { ...dados, autorizaPublicacao: dados.autorizaPublicacao === 'on' }));
          setAviso('Perfil salvo.');
        }}/>}
      </>}
      {tela === 'email' && link && <>
        {link.acao === 'VINCULO' && !sessao ? <>
          <p className="aviso">Entre na mesma conta que solicitou o vínculo.</p>
          <Acesso entrar={entrar} emailDisponivel={emailDisponivel}/>
        </> : <section className="painel estreito painel-formulario">
          <h1>{link.acao === 'VINCULO' ? 'Confirmar seu e-mail' : link.acao === 'CADASTRO' ? 'Confirmar e-mail e criar conta' : link.acao === 'PROPRIETARIO' ? 'Ativar acesso profissional' : 'Definir nova senha'}</h1>
          <Formulario titulo={link.acao === 'VINCULO' ? 'Vincular e-mail' : 'Salvar senha'} enviar={confirmarLink}>{erro =>
            link.acao === 'VINCULO' ? <p>Vincular o endereço à conta de {sessao?.conta.nome}.</p> :
              <Campo nome="senha" rotulo="Senha com pelo menos 15 caracteres" erro={erro}><input type="password" name="senha" autoComplete="new-password" minLength={15} maxLength={128} required/></Campo>
          }</Formulario>
        </section>}
      </>}
      {!sessao && (tela === 'novo' || tela === 'pedidos') && <Acesso key={tela + navegacao.cadastro} entrar={entrar} voltar={() => ir('inicio')} destino={tela} cadastro={navegacao.cadastro} alternarCadastro={cadastro => ir(tela, cadastro)} emailDisponivel={emailDisponivel}/>}
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
      <span>Tatico Assis</span>
      <a href="#area-profissional" onClick={evento => { evento.preventDefault(); abrirAreaProfissional(); }}>Área do profissional</a>
    </footer>
  </>;
}

createRoot(document.getElementById('root')!).render(<App/>);
