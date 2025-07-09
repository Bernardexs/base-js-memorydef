import { createBot, createProvider, createFlow, addKeyword, EVENTS } from '@builderbot/bot'
import { MemoryDB as Database } from '@builderbot/bot'
import { MetaProvider as Provider } from '@builderbot/provider-meta'
import dotenv from 'dotenv'
import axios from 'axios'
dotenv.config()

const PORT = process.env.PORT ?? 3008

export const provider = createProvider(Provider, {
  jwtToken: process.env.jwtToken,
  numberId: process.env.numberId,
  verifyToken: process.env.verifyToken,
  version: process.env.version
})

const afirmaciones = ['SI', 'SÍ', 'CLARO', 'DALE', 'LISTO', 'ACEPTO', 'VOY', 'DE UNA', 'OK']
const negaciones = ['NO', 'NO GRACIAS', 'NUNCA', 'NEGADO', 'AHORA NO', 'NO DESEARÍA', 'PASO']

const INACTIVITY_MINUTES = 1
const inactivityTimers = new Map()
const reminderCounts = new Map()
const PRE_ENCUESTA = -1 // paso especial para recordatorio inicial

function clearReminder(user, paso = null) {
  if (inactivityTimers.has(user)) {
    clearTimeout(inactivityTimers.get(user))
    inactivityTimers.delete(user)
  }
  if (paso !== null) {
    reminderCounts.delete(`${user}-${paso}`)
  }
}

function scheduleReminder(user, paso, state) {
  clearReminder(user)

  const key = `${user}-${paso}`
  const currentCount = reminderCounts.get(key) || 0
  if (currentCount >= 2) return // máximo 2 recordatorios

  const timeoutId = setTimeout(async () => {
    const datos = await state.getMyState()
    if (!datos || datos.paso !== paso) return

    try {
      if (paso === PRE_ENCUESTA) {
        await provider.sendText(
          user,
          '👋 Hola, ¿aún te interesa participar en la encuesta? Responde *sí* o *no* para continuar.'
        )
      } else {
        await provider.sendText(
          user,
          `🙏 ¿Podrías ayudarnos respondiendo la pregunta ${paso + 1}?`
        )
      }
    } catch (e) {
      console.error('❌ Error al enviar recordatorio:', e.message)
    }

    reminderCounts.set(key, currentCount + 1)
    scheduleReminder(user, paso, state)
  }, INACTIVITY_MINUTES * 60 * 1000)

  inactivityTimers.set(user, timeoutId)
}

const encuestaFlow = addKeyword(EVENTS.ACTION)
  .addAction(async (ctx, { state, flowDynamic }) => {
    clearReminder(ctx.from, PRE_ENCUESTA);

    // 1) Recuperar datos
    const { data } = await axios.get('http://localhost:7003/datos-encuesta');
    const { saludos, contactos, preguntas } = data;
    const usuario = contactos.find(u => u.num === ctx.from);
    if (!usuario) {
      await flowDynamic('❌ No se encontró una encuesta asignada para ti.');
      return;
    }

    // 2) Verificar estado actual
    let estadoEncuesta = 'no iniciado';
    try {
      const resp = await axios.post('http://localhost:7003/verificar-estado', {
        idContacto: ctx.from,
        idEncuesta: usuario.idEncuesta
      });
      estadoEncuesta = resp.data.estadoEncuesta;
    } catch (err) {
      // Si es 404, dejamos "no iniciado"
      if (!(err.response && err.response.status === 404)) {
        console.error('Error inesperado al verificar estado:', err);
        throw err;
      }
    }

    if (estadoEncuesta === 'completado') {
      await flowDynamic('✅ Ya completaste la encuesta. ¡Gracias!');
      return;
    }

    // 3) Si no estaba "en progreso", lo iniciamos
    if (estadoEncuesta !== 'en progreso') {
      await axios.post('http://localhost:7003/marcar-como-completada', {
        idContacto: ctx.from,
        idEncuesta: usuario.idEncuesta,
        idEmpresa: usuario.idEmpresa
      });
    }

    // 4) Preparar el estado local y lanzar primera pregunta
    const yaInit = await state.get('preguntas');
    if (yaInit) return;

    await state.update({
      preguntas,
      respuestas: [],
      paso: 0,
      nombre: usuario.nombre,
      despedida: saludos[0]?.saludo3 || '✅ Gracias por participar.'
    });

    await flowDynamic(`✅ ¡Hola ${usuario.nombre}! Empecemos.`);
    const p0 = preguntas[0];
    let msg0 = `1⃣ ${p0.pregunta}`;
    if (p0.textoIni) {
      msg0 += '\n' + p0.textoIni.split('=').map(s => s.trim()).join('\n');
    }
    await flowDynamic(msg0);
    scheduleReminder(ctx.from, 0, state);
  })

  .addAnswer(null, { capture: true }, async (ctx, { state, flowDynamic, gotoFlow }) => {
    clearReminder(ctx.from);
    const datos = await state.getMyState();
    if (!datos?.preguntas) return;

    let { preguntas, respuestas, paso, despedida } = datos;
    const respuesta = ctx.body.trim();
    respuestas.push(respuesta);
    paso++;

    // Si quedan más preguntas...
    if (paso < preguntas.length) {
      const siguiente = preguntas[paso];
      let msg = `${paso + 1}⃣ ${siguiente.pregunta}`;
      if (siguiente.textoIni) {
        msg += '\n' + siguiente.textoIni.split('=').map(s => s.trim()).join('\n');
      }
      await state.update({ preguntas, respuestas, paso, despedida });
      await flowDynamic(msg);
      scheduleReminder(ctx.from, paso, state);
      return gotoFlow(encuestaFlow);
    }

    // ——— 5) Última pregunta respondida: guardar, mostrar resumen y marcar completado —————
    await state.update({ finalizada: true, preguntas: null, respuestas: [], paso: null });
    const resumen = respuestas
      .map((r, i) => `❓ ${preguntas[i].pregunta}\n📝 ${r}`)
      .join('\n\n');

    const payload = preguntas.map((p, i) => ({
      idContacto: ctx.from,
      idEncuesta: p.idEncuesta,
      idEmpresa: p.idEmpresa,
      pregunta: p.pregunta,
      respuesta: respuestas[i],
      tipo: p.tipoRespuesta,
      idPregunta: p.idPregunta
    }));

    try {
      // Guardar respuestas
      await axios.post('http://localhost:7003/guardar-respuestas', payload);
      await flowDynamic('📩 Tus respuestas fueron enviadas exitosamente.');

      // Marcar completado (segunda llamada al mismo endpoint)
      await axios.post('http://localhost:7003/marcar-como-completada', {
        idContacto: ctx.from,
        idEncuesta: preguntas[0].idEncuesta,
        idEmpresa: preguntas[0].idEmpresa
      });
      await flowDynamic('✅ Encuesta completada y registrada exitosamente.');
    } catch (e) {
      console.error('Error al guardar:', e.message);
      await flowDynamic('⚠ Hubo un problema al guardar tus respuestas.');
    }

    await flowDynamic(despedida);
    await flowDynamic(`✅ Tus respuestas:\n\n${resumen}`);
  });


const negacionFlow = addKeyword(negaciones).addAction(async (ctx, { flowDynamic, state }) => {
  await state.update({ finalizada: true }) // ✅ Marca como finalizada si dice NO
  await flowDynamic('✅ Gracias por tu tiempo. Si deseas participar en otro momento, estaré disponible.')
})

const defaultFlow = addKeyword(afirmaciones) // ⚡️ Ya NO usa WELCOME ni mensaje de saludo
  .addAction(async (ctx, { state, gotoFlow, flowDynamic }) => {
   // 1) Consulto el estado en la BD:
    // 🔑 Salta directo al flujo de la encuesta
    return gotoFlow(encuestaFlow)
  })
  .addAnswer(null, { capture: true }, async (ctx, { gotoFlow }) => {
    const respuesta = ctx.body.trim().toUpperCase()
    if (afirmaciones.includes(respuesta)) {
      return gotoFlow(encuestaFlow)
    } else if (negaciones.includes(respuesta)) {
      return gotoFlow(negacionFlow)
    }
  })

const main = async () => {
  const adapterFlow = createFlow([encuestaFlow, negacionFlow, defaultFlow])
  const adapterDB = new Database()

  const { httpServer } = await createBot({
    flow: adapterFlow,
    provider,
    database: adapterDB
  })

  provider.server.get('/v1/prueba', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('✅ Ruta activa: /v1/prueba (GET)')
  })

  httpServer(+PORT)
}

main()
