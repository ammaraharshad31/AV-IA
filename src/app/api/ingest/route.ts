import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getEmbeddings } from '@/lib/embeddings/pipeline';
import { chunkText } from '@/lib/embeddings/textSplitter';
import { Database } from '@/lib/supabase/database.types';
// @ts-ignore
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';

// Use service role key to bypass RLS for inserting admin data
const supabase = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: Request) {
    try {
        const formData = await req.formData();
        const title = formData.get('title') as string;
        const courseId = formData.get('courseId') as string;
        const file = formData.get('file') as File | null;
        let content = formData.get('content') as string || '';

        if (!title || (!content && !file)) {
            return NextResponse.json({ error: 'Título y contenido (o archivo) son obligatorios' }, { status: 400 });
        }

        // 1. Extract content from file if provided
        if (file) {
            const arrayBuffer = await file.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const fileType = file.name.split('.').pop()?.toLowerCase();

            if (fileType === 'pdf') {
                try {
Const parser = new PDFParse({ data: buffer });

const pdfData = await parser.getText();

content = pdfData.text;

await parser.destroy();
                } catch (err: any) {
                    console.error("PDF Parsing Error:", err);
                    return NextResponse.json({ error: 'Error al procesar el archivo PDF' }, { status: 400 });
                }
            } else if (fileType === 'docx') {
                const result = await mammoth.extractRawText({ buffer });
                content = result.value;
            } else if (fileType === 'txt') {
                content = buffer.toString('utf-8');
            } else {
                return NextResponse.json({ error: 'Tipo de archivo no soportado. Usa PDF, DOCX o TXT.' }, { status: 400 });
            }
        }

        if (!content || content.trim().length === 0) {
            return NextResponse.json({ error: 'No se pudo extraer contenido del archivo o el contenido está vacío' }, { status: 400 });
        }

        // 2. Insert document
        const { data: document, error: docError } = await (supabase
            .from('documents') as any)
            .insert({
                title,
                content,
                course_id: courseId || null,
                metadata: { 
                    source: file ? file.name : 'manual_input',
                    fileType: file ? file.name.split('.').pop() : 'text'
                }
            })
            .select()
            .single();

        if (docError || !document) throw docError;

        // 3. Chunk text
        const chunks = chunkText(content);
        let insertedChunks = 0;

        // 4. Process chunks sequentially
        for (const chunk of chunks) {
            const embeddingVector = await getEmbeddings(chunk);
            const embeddingString = `[${embeddingVector.join(',')}]`;

            const { error: chunkError } = await (supabase
                .from('document_sections') as any)
                .insert({
                    document_id: document.id,
                    content: chunk,
                    embedding: embeddingString
                });

            if (chunkError) {
                console.error("Error inserting chunk:", chunkError);
                continue;
            }
            insertedChunks++;
        }

        return NextResponse.json({ 
            success: true, 
            documentId: document.id, 
            chunksProcessed: insertedChunks,
            totalChunks: chunks.length
        });

    } catch (error: any) {
        console.error('Ingest API Error:', error);
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
    }
}
