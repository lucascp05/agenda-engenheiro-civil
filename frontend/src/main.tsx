import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type Conta = { nome: string; celular: string; papel: 'CLIENTE' | 'ENGENHEIRO' };
type Sessao = { conta: Conta; token: string };
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
const rotulos: Record<Situacao, string> = {
  RECEBIDO: 'Pedido recebido', INFORMACOES: 'Precisamos de informações',
  MARCADO: 'Visita marcada', CONCLUIDO: 'Concluído',
};
const servicos = ['Topografia', 'CAR', 'INCRA', 'Projetos', 'Não sei qual serviço preciso'];
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

async function api<T>(rota: string, token?: string, dados?: object): Promise<T> {
  let resposta: Response;
  try {
    resposta = await fetch(apiUrl + rota, {
      method: dados ? 'POST' : 'GET',
      headers: { ...(token && { Authorization: 'Bearer ' + token }), ...(dados && { 'Content-Type': 'application/json' }) },
      body: dados && JSON.stringify(dados),
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

function Campo({ nome, rotulo, erro, children }: { nome: string; rotulo: string; erro?: Falha; children: ReactNode }) {
  const mensagem = erro?.campos[nome];
  return <label className={mensagem ? 'campo invalido' : 'campo'}>
    <span>{rotulo}</span>{children}{mensagem && <small role="alert">{mensagem}</small>}
  </label>;
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
    <fieldset disabled={ocupado}>{children(erro)}
      {erro && <p className="erro" role="alert">{erro.message}</p>}
      <button className="primario" type="submit">{ocupado ? 'Aguarde…' : titulo}</button>
    </fieldset>
  </form>;
}

function Acesso({ entrar }: { entrar: (sessao: Sessao) => void }) {
  const [cadastro, setCadastro] = useState(false);
  return <section className="painel estreito">
    <h1>{cadastro ? 'Crie sua conta' : 'Entre na sua conta'}</h1>
    <p>Use seu celular com DDD e sua senha.</p>
    <Formulario key={String(cadastro)} titulo={cadastro ? 'Criar conta' : 'Entrar'} enviar={async dados => entrar(await api<Sessao>(cadastro ? '/auth/cadastro' : '/auth/login', undefined, dados))}>
      {erro => <>
        {cadastro && <Campo nome="nome" rotulo="Nome" erro={erro}><input name="nome" autoComplete="name" required minLength={2} maxLength={80}/></Campo>}
        <Campo nome="celular" rotulo="Celular com DDD" erro={erro}><input name="celular" type="tel" autoComplete="username" required maxLength={20} placeholder="(84) 99999-9999"/></Campo>
        <Campo nome="senha" rotulo="Senha" erro={erro}><input name="senha" type="password" autoComplete={cadastro ? 'new-password' : 'current-password'} required minLength={8} maxLength={128}/></Campo>
      </>}
    </Formulario>
    <button className="texto" onClick={() => setCadastro(!cadastro)}>{cadastro ? 'Já tenho conta' : 'Criar uma conta'}</button>
  </section>;
}

function NovoPedido({ enviar }: { enviar: (dados: object) => Promise<void> }) {
  return <section className="painel estreito">
    <h1>Pedir uma visita</h1>
    <p>Conte o que você precisa e onde será a visita.</p>
    <Formulario titulo="Enviar pedido" enviar={enviar}>{erro => <>
      <Campo nome="servico" rotulo="Tipo de serviço" erro={erro}><select name="servico" required defaultValue=""><option value="" disabled>Selecione um serviço</option>{servicos.map(s => <option key={s}>{s}</option>)}</select></Campo>
      <Campo nome="municipio" rotulo="Município" erro={erro}><input name="municipio" required minLength={2} maxLength={90}/></Campo>
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
    {engenheiro && <p><strong>{pedido.cliente.nome}</strong> · <a href={'tel:+55' + pedido.cliente.celular}>{pedido.cliente.celular.replace(/^(\d{2})(\d{5})(\d{4})$/, '($1) $2-$3')}</a></p>}
    <p>{lugarDe(pedido)}</p>
    <p>{pedido.descricao}</p>
    {pedido.link && <p><a href={pedido.link} target="_blank" rel="noreferrer">Abrir link de localização</a></p>}
    {pedido.visita && <p className="horario"><strong>{dataDe(diaDe(pedido.visita.horario))} às {horarioDe(pedido.visita.horario)}</strong> <span>Horário de Brasília</span></p>}
    {!!pedido.mensagens.length && <ul className="conversa" aria-label="Mensagens do pedido">{pedido.mensagens.map(m => <li key={m.id}><strong>{m.autor === 'ENGENHEIRO' ? 'Engenheiro' : 'Cliente'}</strong><p>{m.texto}</p></li>)}</ul>}
    {!engenheiro && pedido.situacao === 'INFORMACOES' && <Formulario titulo="Enviar resposta" enviar={dados => enviar('respostas', dados)}>{erro =>
      <Campo nome="texto" rotulo="Sua resposta" erro={erro}><textarea name="texto" rows={2} required minLength={3} maxLength={400}/></Campo>
    }</Formulario>}
    {engenheiro && pedido.situacao !== 'CONCLUIDO' && <div className="acoes">
      {aberto && <><button className="secundario" onClick={() => setAcao('visitas')}>Marcar visita</button><button className="secundario" onClick={() => setAcao('informacoes')}>Pedir informações</button></>}
      <button className="secundario" onClick={() => setAcao('conclusao')}>Concluir atendimento</button>
    </div>}
    {acao && <div className="editor">
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
      {proxima ? <><p><strong>{proxima.pedido.cliente.nome}</strong> · {dataDe(diaDe(proxima.horario))} às {horarioDe(proxima.horario)}</p><p>{lugarDe(proxima.pedido)}</p></> : <p>Nenhuma visita futura confirmada.</p>}
    </section>
    <section className="painel">
      <div className="linha"><h2>Visitas do dia</h2><Campo nome="dia" rotulo="Dia da agenda"><input type="date" value={dia} onChange={e => setDia(e.target.value || dataISO.format())}/></Campo></div>
      {!!dias.length && <div className="acoes">{dias.map(data => <button key={data} className="secundario" aria-pressed={data === dia} onClick={() => setDia(data)}>{dataDe(data)}</button>)}</div>}
      <p className="suave">Horário de Brasília</p>
      {doDia.length ? <ul className="visitas">{doDia.map(v => <li key={v.id}><time dateTime={v.horario}>{horarioDe(v.horario)}</time><div><strong>{v.pedido.cliente.nome}</strong><p>{lugarDe(v.pedido)}</p></div></li>)}</ul> : <p>Nenhuma visita confirmada para este dia.</p>}
    </section>
  </>;
}

type Tela = 'inicio' | 'novo' | 'pedidos' | 'agenda';
function App() {
  const [sessao, setSessao] = useState(lerSessao);
  const [tela, setTela] = useState<Tela>(() => lerSessao()?.conta.papel === 'ENGENHEIRO' ? 'agenda' : 'inicio');
  const [pedidos, setPedidos] = useState<Pedido[]>([]);
  const [visitas, setVisitas] = useState<Visita[]>([]);
  const [filtros, setFiltros] = useState('');
  const [recarga, setRecarga] = useState(0);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');
  const engenheiro = sessao?.conta.papel === 'ENGENHEIRO';

  function sair() {
    sessionStorage.removeItem('agenda.sessao');
    setSessao(null);
    setPedidos([]);
    setVisitas([]);
    setFiltros('');
    ir('inicio');
  }

  function ir(destino: Tela) {
    setErro('');
    setAviso('');
    setTela(destino);
    window.scrollTo(0, 0);
  }

  useEffect(() => {
    if (!sessao || (tela !== 'pedidos' && tela !== 'agenda')) return;
    let ativa = true;
    setErro('');
    setCarregando(true);
    const buscar = tela === 'agenda'
      ? api<Visita[]>('/visitas', sessao.token).then(lista => { if (ativa) setVisitas(lista); })
      : api<Pedido[]>('/pedidos' + (filtros ? '?' + filtros : ''), sessao.token).then(lista => { if (ativa) setPedidos(lista); });
    void buscar.catch((e: Falha) => {
      if (!ativa) return;
      if (e.status === 401) {
        sair();
        setAviso(e.message);
      } else setErro(e.message);
    }).finally(() => { if (ativa) setCarregando(false); });
    return () => { ativa = false; };
  }, [sessao, tela, filtros, recarga]);

  function entrar(nova: Sessao) {
    sessionStorage.setItem('agenda.sessao', JSON.stringify(nova));
    setSessao(nova);
    if (nova.conta.papel === 'ENGENHEIRO') ir('agenda');
  }

  async function enviar<T>(rota: string, dados: object) {
    try { return await api<T>(rota, sessao?.token, dados); }
    catch (e) {
      if (e instanceof Falha && e.status === 401) {
        sair();
        setAviso(e.message);
      }
      throw e;
    }
  }

  return <>
    <header className="topo"><div className="limite barra">
      <button className="marca" onClick={() => ir(engenheiro ? 'agenda' : 'inicio')}><span aria-hidden="true">⌖</span> Agenda do Engenheiro Civil</button>
      <nav aria-label="Navegação principal">
        {sessao && (engenheiro
          ? <><button aria-current={tela === 'pedidos' ? 'page' : undefined} onClick={() => ir('pedidos')}>Pedidos</button><button aria-current={tela === 'agenda' ? 'page' : undefined} onClick={() => ir('agenda')}>Agenda</button></>
          : <button onClick={() => ir('pedidos')}>Meus pedidos</button>)}
        {sessao ? <button onClick={sair}>Sair</button> : <button onClick={() => ir('pedidos')}>Entrar</button>}
      </nav>
    </div></header>
    <main className="limite">
      {aviso && <p className="aviso" role="status">{aviso}</p>}
      {tela === 'inicio' && <section className="hero">
        <div className="hero-conteudo">
          <p className="sobretitulo">Engenharia civil · Atendimento em campo</p>
          <h1>Agende uma<br className="desktop"/> visita técnica</h1>
          <p>Solicite atendimento para topografia, CAR, INCRA ou projetos e acompanhe a confirmação por aqui.</p>
          <div className="acoes"><button className="primario" onClick={() => ir('novo')}>Pedir uma visita</button><button className="secundario" onClick={() => ir('pedidos')}>Meus pedidos</button></div>
        </div>
        <div className="terreno" aria-hidden="true"><div className="curvas"/><div className="alvo">⌖</div></div>
      </section>}
      {tela === 'inicio' && <section className="fluxo"><div><h2>Conte o que precisa</h2><p>Informe o serviço e como chegar ao local.</p></div><div><h2>Acompanhe o pedido</h2><p>Veja mensagens, dia e horário na sua conta.</p></div></section>}
      {!sessao && tela !== 'inicio' && <Acesso entrar={entrar}/>}
      {sessao && tela === 'novo' && <NovoPedido enviar={async dados => {
        await enviar('/pedidos', dados);
        ir('pedidos');
        setAviso('Pedido enviado. O engenheiro vai informar o dia e a hora por aqui.');
      }}/>}
      {sessao && (tela === 'pedidos' || tela === 'agenda') && <>
        <div className="linha cabecalho"><h1>{tela === 'agenda' ? 'Agenda' : engenheiro ? 'Pedidos' : 'Meus pedidos'}</h1>
          <div className="acoes">{!engenheiro && <button className="primario" onClick={() => ir('novo')}>Pedir uma visita</button>}
          <button className="secundario" onClick={() => setRecarga(n => n + 1)}>Atualizar</button></div>
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
        {erro && <p className="erro" role="alert">{erro}</p>}
        {carregando && <p role="status">Carregando…</p>}
        {tela === 'agenda' && !carregando && !erro && <Agenda visitas={visitas}/>}
        {tela === 'pedidos' && !carregando && !erro && !pedidos.length && <p className="painel">Nenhum pedido encontrado.</p>}
        {tela === 'pedidos' && pedidos.map(pedido => <CartaoPedido key={pedido.id} pedido={pedido} engenheiro={engenheiro} mudar={async (acao, dados) => {
          const atualizado = await enviar<Pedido>(acao === 'visitas' ? '/visitas' : '/pedidos/' + pedido.id + '/' + acao, dados);
          setPedidos(lista => lista.map(item => item.id === atualizado.id ? atualizado : item));
        }}/>)}
      </>}
    </main>
    <footer className="limite rodape">Agenda do Engenheiro Civil</footer>
  </>;
}

createRoot(document.getElementById('root')!).render(<App/>);
